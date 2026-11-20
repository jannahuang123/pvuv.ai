/**
 * Stateless MCP (JSON-RPC over HTTP) on the api worker.
 *
 * Cursor and other clients POST here with the same personal API token they
 * would put in PVUV_TOKEN. `create_site` is the only write; a domain that
 * already exists is returned as-is. Every other tool only reads.
 */

import { parsePeriod, siteTimezone, overview, realtime, timeseries, breakdown, quality, alerts, adguardImpact, edge, traffic, vitals, anomalies, ApiError } from './queries';
import { createOrGetSite, embedExisting, type SiteWriteEnv } from './sites';

export interface McpEnv extends SiteWriteEnv {
  DB: D1Database;
}

export interface Caller {
  ownerId: string | null;
  siteId: string | null;
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}

const PROTOCOL = '2024-11-05';

const siteArg = { site_id: { type: 'string', description: 'Site id from list_sites or create_site' } };
const periodArg = {
  period: {
    type: 'string',
    enum: ['24h', 'today', 'yesterday', '7d', '30d', '90d', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year'],
    description: 'Date range, resolved in the site timezone. Default 7d.',
  },
};

export const MCP_TOOLS = [
  {
    name: 'list_sites',
    description: 'List sites this token can read. Call this before querying. Ids are not guessable.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_site',
    description: 'Register a website and return the tracking snippet to paste before </head>. If that domain (or a parent/subdomain of it) is already registered, returns the existing site and its snippet instead of creating a duplicate. This does not edit the website itself; someone still has to paste the snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name, required only when the domain is new' },
        domain: { type: 'string', description: 'Site domain, e.g. example.com. A URL is accepted and reduced to the host.' },
        timezone: { type: 'string', description: 'IANA timezone, fixed at creation. Default: the account timezone, else UTC. Use Asia/Shanghai for China sites.' },
        adguard_mode: { type: 'string', enum: ['off', 'loose', 'balanced', 'strict'], description: 'Ad protection. Default off.' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_embed',
    description: 'Return the tracking snippet for a site that already exists.',
    inputSchema: { type: 'object', properties: { ...siteArg }, required: ['site_id'] },
  },
  {
    name: 'get_overview',
    description: 'Pageviews, visitors, sessions, bounce rates, dwell, and the clean / suspect / bot / crawler split. Use this to see whether a change helped.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_realtime',
    description: 'Visitors active in the last 30 minutes. Ignores period.',
    inputSchema: { type: 'object', properties: { ...siteArg }, required: ['site_id'] },
  },
  {
    name: 'get_timeseries',
    description: 'One metric over time. Each bucket includes pageviews and how many were invalid.',
    inputSchema: {
      type: 'object',
      properties: {
        ...siteArg, ...periodArg,
        metric: { type: 'string', enum: ['pv', 'uv', 'sessions', 'bounce_rate', 'bounce_rate_single', 'avg_duration_ms', 'visit_duration_ms'], description: 'Default pv' },
        interval: { type: 'string', enum: ['minute', 'hour', 'day', 'week', 'month'] },
      },
      required: ['site_id'],
    },
  },
  {
    name: 'get_breakdown',
    description: 'Top pages, sources, countries, devices, or other dimensions, with pageviews and visitors. Use this to decide what to change.',
    inputSchema: {
      type: 'object',
      properties: {
        ...siteArg, ...periodArg,
        dimension: { type: 'string', description: 'page, entry_page, exit_page, source, channel, country, device, browser, os, utm_campaign, goal, bot_category, …' },
        limit: { type: 'number', description: 'Default 20, max 1000' },
      },
      required: ['site_id', 'dimension'],
    },
  },
  {
    name: 'get_traffic_quality',
    description: 'Why traffic was judged invalid: verdict totals and which detection signals fired.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_alerts',
    description: 'Rule checks for suspicious data (invalid share, datacenter share, no-interaction visits, forged search referrals) with the threshold each one is measured against.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_vitals',
    description: 'Web Vitals (LCP, CLS, INP, FCP, TTFB) from non-bot traffic, plus the slowest pages.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_anomalies',
    description: 'Recent baseline anomalies: a dimension that jumped or dropped versus its own history.',
    inputSchema: { type: 'object', properties: { ...siteArg }, required: ['site_id'] },
  },
  {
    name: 'get_ad_protection',
    description: 'Estimated ad-block impact per tier, with block reasons.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_edge_requests',
    description: 'Cloudflare edge requests versus script pageviews. The gap is clients that fetched HTML but never ran JavaScript. available:false when no Cloudflare API token is configured.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_suspicious_visitors',
    description: 'High-scoring visitors with their evidence flags.',
    inputSchema: {
      type: 'object',
      properties: {
        ...siteArg, ...periodArg,
        min_score: { type: 'number', description: 'Default 30' },
        limit: { type: 'number', description: 'Default 50' },
      },
      required: ['site_id'],
    },
  },
];

function rpcResult(id: Rpc['id'], result: unknown): Response {
  return json({ jsonrpc: '2.0', id: id ?? null, result });
}
function rpcError(id: Rpc['id'], code: number, message: string): Response {
  return json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
    },
  });
}

export async function handleMcp(
  request: Request,
  env: McpEnv,
  resolveCaller: (request: Request) => Promise<Caller>,
): Promise<Response> {
  if (request.method === 'OPTIONS') return json(null, 204);
  if (request.method === 'GET') {
    return json({ name: 'pvuv.ai', protocol: PROTOCOL, tools: MCP_TOOLS.map((t) => t.name) });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let msg: Rpc;
  try { msg = await request.json(); } catch { return rpcError(null, -32700, 'parse error'); }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'pvuv.ai', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return new Response(null, { status: 202 });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS });

  if (method !== 'tools/call') return rpcError(id, -32601, `unknown method: ${method}`);

  let caller: Caller;
  try { caller = await resolveCaller(request); } catch (err) {
    const message = err instanceof ApiError ? err.message : 'auth required';
    return rpcResult(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
  }

  try {
    const text = await callTool(env, caller, params?.name, params?.arguments ?? {});
    return rpcResult(id, { content: [{ type: 'text', text }] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return rpcResult(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
  }
}

async function callTool(env: McpEnv, caller: Caller, name: string | undefined, args: Record<string, unknown>): Promise<string> {
  if (name === 'list_sites') return JSON.stringify(await listSites(env, caller), null, 2);
  if (name === 'create_site') {
    if (!caller.ownerId) throw new ApiError(403, 'a personal API token is required to create a site');
    if (caller.siteId) throw new ApiError(403, 'this token is limited to one existing site and cannot register another');
    return JSON.stringify(await createOrGetSite(env, caller.ownerId, {
      name: str(args.name),
      domain: str(args.domain),
      domains: Array.isArray(args.domains) ? args.domains.filter((d): d is string => typeof d === 'string') : undefined,
      timezone: str(args.timezone),
      adguard_mode: str(args.adguard_mode),
    }), null, 2);
  }

  const siteId = str(args.site_id);
  if (!siteId) throw new ApiError(400, 'site_id is required — call list_sites first');
  await assertSite(env, caller, siteId);
  const periodName = str(args.period) || '7d';

  if (name === 'get_embed') return JSON.stringify(await embedExisting(env, siteId), null, 2);

  const tz = await siteTimezone(env.DB, siteId);
  const period = parsePeriod(periodName, tz);
  if (name === 'get_overview') return dump(await overview(env.DB, siteId, period));
  if (name === 'get_realtime') return dump(await realtime(env.DB, siteId, Date.now()));
  if (name === 'get_timeseries') {
    return dump(await timeseries(env.DB, siteId, str(args.metric) || 'pv', period, str(args.interval) || 'day'));
  }
  if (name === 'get_breakdown') {
    const dim = str(args.dimension);
    if (!dim) throw new ApiError(400, 'dimension is required');
    return dump(await breakdown(env.DB, siteId, dim, period, num(args.limit, 20)));
  }
  if (name === 'get_traffic_quality') return dump(await quality(env.DB, siteId, period));
  if (name === 'get_alerts') return dump(await alerts(env.DB, siteId, period));
  if (name === 'get_vitals') return dump(await vitals(env.DB, siteId, period));
  if (name === 'get_anomalies') return dump(await anomalies(env.DB, siteId));
  if (name === 'get_ad_protection') return dump(await adguardImpact(env.DB, siteId, period));
  if (name === 'get_edge_requests') return dump(await edge(env.DB, siteId, period));
  if (name === 'get_suspicious_visitors') {
    return dump(await traffic(env.DB, siteId, period, {
      minScore: args.min_score == null ? 30 : num(args.min_score, 30),
      limit: num(args.limit, 50),
    }));
  }
  throw new ApiError(400, `unknown tool: ${name}`);
}

async function listSites(env: McpEnv, caller: Caller) {
  const where = ["status = 'active'", "name != '__pvuv_selftest'"];
  const binds: unknown[] = [];
  if (caller.ownerId) { where.push('owner_id = ?'); binds.push(caller.ownerId); }
  if (caller.siteId) { where.push('site_id = ?'); binds.push(caller.siteId); }
  const rows = await env.DB.prepare(
    `SELECT site_id, name, allowed_domains, timezone, created_at FROM sites WHERE ${where.join(' AND ')} ORDER BY created_at`,
  ).bind(...binds).all<{ site_id: string; name: string; allowed_domains: string; timezone: string; created_at: number }>();
  return {
    sites: rows.results.map((r) => {
      let domains: string[] = [];
      try { domains = JSON.parse(r.allowed_domains); } catch { /* ignore */ }
      return { site_id: r.site_id, name: r.name, domains, timezone: r.timezone, created_at: r.created_at };
    }),
  };
}

async function assertSite(env: McpEnv, caller: Caller, siteId: string): Promise<void> {
  if (!/^[A-Za-z0-9]{4,16}$/.test(siteId)) throw new ApiError(400, 'bad site_id');
  if (caller.siteId && caller.siteId !== siteId) throw new ApiError(403, 'token not valid for this site');
  if (!caller.ownerId) return; // deployment-wide token already authenticated
  const site = await env.DB.prepare('SELECT owner_id FROM sites WHERE site_id = ?')
    .bind(siteId).first<{ owner_id: string }>();
  if (!site || site.owner_id !== caller.ownerId) throw new ApiError(403, 'not your site');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}
function dump(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
