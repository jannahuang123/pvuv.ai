/**
 * Site registration for programmatic clients (MCP / API token).
 *
 * Creating a site is the one write this API allows. A domain that already
 * belongs to the caller returns that site instead of inserting another row —
 * the console has no delete button, so a duplicate is sticky.
 */

import { generateSiteId } from '../../../shared/ids';
import { isValidTimezone } from '../../../shared/tz';
import { CONFIG } from '../../../shared/config.gen';
import { ApiError } from './queries';

export interface SiteWriteEnv {
  DB: D1Database;
  SITE_CONFIG?: KVNamespace;
  /** Hostname only, no scheme. Where f.js is hosted (the console). */
  SCRIPT_HOST?: string;
  /** Hostname only, no scheme. Where the snippet posts events. */
  INGEST_HOST?: string;
}

export interface SiteRow {
  site_id: string;
  name: string;
  domains: string[];
  adguard_mode: string;
  adclient: string | null;
  timezone: string;
}

const ADGUARD_MODES = new Set(['off', 'loose', 'balanced', 'strict']);

export function normalizeDomain(raw: string): string | null {
  const d = String(raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  return d;
}

/** True when one host is the other, or a subdomain of it. */
export function domainsOverlap(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function hostOnly(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

export function embedFor(env: SiteWriteEnv, site: { site_id: string; adguard_mode: string; adclient: string | null }): {
  script_src: string;
  ingest_url: string;
  snippet: string;
} {
  const scriptHost = hostOnly(env.SCRIPT_HOST);
  const ingestHost = hostOnly(env.INGEST_HOST);
  const script_src = scriptHost ? `https://${scriptHost}/f.js` : '';
  const ingest_url = ingestHost ? `https://${ingestHost}` : '';
  const attrs = [`data-site="${site.site_id}"`];
  if (ingest_url) attrs.push(`data-api="${ingest_url}"`);
  if (site.adguard_mode && site.adguard_mode !== 'off') attrs.push(`data-adguard="${site.adguard_mode}"`);
  if (site.adclient) attrs.push(`data-adclient="${site.adclient}"`);
  const snippet = script_src
    ? `<script defer src="${script_src}"\n        ${attrs.join('\n        ')}></script>`
    : '';
  return { script_src, ingest_url, snippet };
}

async function loadOwned(env: SiteWriteEnv, ownerId: string): Promise<Array<SiteRow & { status: string }>> {
  const rows = await env.DB.prepare(
    `SELECT site_id, name, allowed_domains, adguard_mode, adclient, timezone, status
     FROM sites WHERE owner_id = ? AND name != '__pvuv_selftest'`,
  ).bind(ownerId).all<{
    site_id: string; name: string; allowed_domains: string; adguard_mode: string;
    adclient: string | null; timezone: string | null; status: string;
  }>();
  return rows.results.map((r) => {
    let domains: string[] = [];
    try {
      const parsed = JSON.parse(r.allowed_domains);
      if (Array.isArray(parsed)) domains = parsed.filter((d): d is string => typeof d === 'string');
    } catch { /* malformed row → no domains */ }
    return {
      site_id: r.site_id,
      name: r.name,
      domains,
      adguard_mode: r.adguard_mode || 'off',
      adclient: r.adclient,
      timezone: r.timezone || 'UTC',
      status: r.status,
    };
  });
}

/** Snippet for a site the caller has already been authorized to read. */
export async function embedExisting(env: SiteWriteEnv, siteId: string) {
  const row = await env.DB.prepare(
    `SELECT site_id, name, allowed_domains, adguard_mode, adclient, timezone
     FROM sites WHERE site_id = ? AND status = 'active'`,
  ).bind(siteId).first<{
    site_id: string; name: string; allowed_domains: string; adguard_mode: string | null;
    adclient: string | null; timezone: string | null;
  }>();
  if (!row) throw new ApiError(404, 'not found');
  let domains: string[] = [];
  try {
    const parsed = JSON.parse(row.allowed_domains);
    if (Array.isArray(parsed)) domains = parsed.filter((d): d is string => typeof d === 'string');
  } catch { /* report none */ }
  const site: SiteRow = {
    site_id: row.site_id,
    name: row.name,
    domains,
    adguard_mode: row.adguard_mode || 'off',
    adclient: row.adclient,
    timezone: row.timezone || 'UTC',
  };
  return { ...publicSite(site), ...embedFor(env, site) };
}

function publicSite(site: SiteRow) {
  return {
    site_id: site.site_id,
    name: site.name,
    domains: site.domains,
    timezone: site.timezone,
    adguard_mode: site.adguard_mode,
  };
}

export async function createOrGetSite(env: SiteWriteEnv, ownerId: string, body: {
  name?: string;
  domain?: string;
  domains?: string[];
  timezone?: string;
  adguard_mode?: string;
  adclient?: string;
}): Promise<Record<string, unknown>> {
  const requested = [body.domain, ...(Array.isArray(body.domains) ? body.domains : [])]
    .flatMap((d) => (d == null ? [] : [d]))
    .map(normalizeDomain)
    .filter((d): d is string => !!d);
  const domains = [...new Set(requested)];
  if (domains.length === 0) throw new ApiError(400, 'a valid domain is required, e.g. example.com');

  const owned = (await loadOwned(env, ownerId)).filter((s) => s.status === 'active');
  const existing = owned.find((s) => s.domains.some((have) => domains.some((want) => domainsOverlap(have, want))));
  if (existing) {
    const covered = domains.filter((d) => existing.domains.some((have) => domainsOverlap(have, d)));
    return {
      created: false,
      ...publicSite(existing),
      matched_domains: covered,
      ...embedFor(env, existing),
      note: 'This domain is already registered, so no second site was created. Paste the snippet into the site; do not create another one for the same domain.',
    };
  }

  const name = (body.name ?? '').trim().slice(0, 100);
  if (!name) throw new ApiError(400, 'name is required when the domain is new');
  const adguardMode = ADGUARD_MODES.has(body.adguard_mode ?? '') ? body.adguard_mode! : 'off';
  const adclient = body.adclient && /^ca-pub-\d{6,20}$/.test(body.adclient) ? body.adclient : null;

  let timezone = (body.timezone ?? '').trim();
  if (!timezone) {
    const row = await env.DB.prepare('SELECT timezone FROM users WHERE user_id = ?')
      .bind(ownerId).first<{ timezone: string | null }>();
    timezone = row?.timezone || 'UTC';
  }
  if (!isValidTimezone(timezone)) throw new ApiError(400, `invalid timezone: ${timezone}`);

  const createdAt = Date.now();
  const shadowUntil = createdAt + Math.max(0, CONFIG.adguard.shadow_days) * 86_400_000;
  const engagedSeconds = 15;
  const siteId = generateSiteId();
  await env.DB.prepare(`
    INSERT INTO sites (site_id, name, owner_id, allowed_domains, adguard_mode, adclient, timezone, engaged_seconds, shadow_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(siteId, name, ownerId, JSON.stringify(domains), adguardMode, adclient, timezone, engagedSeconds, shadowUntil, createdAt).run();

  const site: SiteRow = { site_id: siteId, name, domains, adguard_mode: adguardMode, adclient, timezone };
  if (env.SITE_CONFIG) {
    await env.SITE_CONFIG.put(`site:${siteId}`, JSON.stringify({
      site_id: siteId,
      allowed_domains: domains,
      adguard_mode: adguardMode,
      adclient,
      status: 'active',
      shadow_until: shadowUntil,
    }), { expirationTtl: 300 });
  }

  return {
    created: true,
    ...publicSite(site),
    ...embedFor(env, site),
    note: 'Site created. Paste the snippet before </head> on every page of that domain. Tracking starts after the snippet is live; pull overview and breakdown once visits arrive.',
  };
}
