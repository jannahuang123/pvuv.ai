/**
 * Order / checkout-failure journeys.
 *
 * The consumer writes one notice per outcome event, with the session path
 * folded into a message. Delivery is a webhook the owner pastes (Slack or
 * Feishu/Lark incoming bot). Notices stay in D1 either way, so the API and
 * MCP can read them for optimization even when no webhook is set.
 */

import { monthSuffix } from './events';
import type { EventRow } from './events';

const ORDER_EVENTS = new Set(['order', 'purchase', 'checkout_complete', 'payment_success']);
const FAIL_EVENTS = new Set(['order_failed', 'checkout_failed', 'payment_failed', 'order_fail']);

export const NOTIFY_WEBHOOK_KEY = 'notify_webhook';

export type JourneyKind = 'order' | 'failed';

export interface JourneyStep {
  ts: number;
  event: string;
  path: string;
}

export function journeyKind(event: string): JourneyKind | null {
  const name = event.toLowerCase();
  if (ORDER_EVENTS.has(name)) return 'order';
  if (FAIL_EVENTS.has(name)) return 'failed';
  return null;
}

/** https only, and not a loopback or link-local host. The owner pastes this. */
export function normalizeWebhook(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return null;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return null;
  return url.toString();
}

export function formatJourney(input: {
  siteName: string;
  kind: JourneyKind;
  event: string;
  userId: string | null;
  visitorId: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  referrer: string | null;
  channel: string | null;
  entry: string | null;
  exit: string | null;
  country: string | null;
  device: string | null;
  revenue: number | null;
  currency: string | null;
  reason: string | null;
  steps: JourneyStep[];
}): string {
  const title = input.kind === 'order' ? '下单成功' : '下单失败';
  const who = input.userId ? `用户 ${input.userId}` : `匿名访客 ${input.visitorId.slice(0, 8)}`;
  const fromRaw = [input.channel, input.source, input.medium, input.campaign].filter(Boolean).join(' / ')
    || input.referrer || '直接访问';
  const from = fromRaw === 'direct' ? '直接访问' : fromRaw;
  const pages = input.steps.filter((s) => s.event === 'pageview' && s.path).map((s) => s.path);
  const outcome = [...input.steps].reverse().find((s) => s.event !== 'pageview' && s.path);
  if (outcome && outcome.path !== pages[pages.length - 1]) {
    pages.push(`${outcome.path}（${input.kind === 'order' ? '下单' : '失败'}）`);
  }
  const path = pages.join(' → ') || '（没有页面记录）';
  const left = outcome?.path || input.exit || input.entry || '（未知）';
  const lines = [
    `${title} · ${input.siteName}`,
    who,
    `从 ${from} 进入 ${input.entry || '（未知）'}`,
    `路径：${path}`,
    `最后所在：${left}`,
  ];
  if (input.kind === 'order' && input.revenue != null) {
    lines.push(`金额：${input.revenue} ${input.currency || ''}`.trim());
  }
  if (input.kind === 'failed' && input.reason) lines.push(`原因：${input.reason}`);
  const where = [input.country, input.device].filter(Boolean).join(' · ');
  if (where) lines.push(where);
  return lines.join('\n');
}

function reasonFrom(row: EventRow): string | null {
  if (!row.props) return null;
  try {
    const props = JSON.parse(row.props) as Record<string, unknown>;
    const value = props.reason ?? props.error ?? props.message;
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

interface SessionBits {
  entry_page: string | null;
  exit_page: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  referrer: string | null;
  channel: string | null;
  country: string | null;
  device_type: string | null;
  user_id: string | null;
}

/** Write notices for outcome events in this batch, then try to deliver any
 *  that have not been sent. Failures here must not fail the queue batch. */
export async function recordJourneys(db: D1Database, rows: EventRow[]): Promise<void> {
  for (const row of rows) {
    if (!journeyKind(row.event)) continue;
    try { await recordOne(db, row); } catch (err) { console.error('journey notice', err); }
  }
  try { await deliverPending(db); } catch (err) { console.error('journey deliver', err); }
}

async function recordOne(db: D1Database, row: EventRow): Promise<void> {
  const kind = journeyKind(row.event);
  if (!kind || !row.eid) return;
  const existing = await db.prepare('SELECT 1 AS ok FROM journey_notices WHERE site_id = ? AND eid = ?')
    .bind(row.site_id, row.eid).first();
  if (existing) return;

  const session = await db.prepare(`
    SELECT entry_page, exit_page, source, medium, campaign, referrer, channel, country, device_type, user_id
    FROM sessions WHERE site_id = ? AND session_id = ?
  `).bind(row.site_id, row.session_id).first<SessionBits>();

  let steps: JourneyStep[] = [];
  try {
    const table = `events_${monthSuffix(row.ts)}`;
    const ev = await db.prepare(
      `SELECT ts, event, path FROM ${table} WHERE site_id = ? AND session_id = ? ORDER BY ts ASC LIMIT 40`,
    ).bind(row.site_id, row.session_id).all<JourneyStep>();
    steps = ev.results;
  } catch { /* month table missing — the message still carries the session entry/exit */ }

  const site = await db.prepare('SELECT name FROM sites WHERE site_id = ?')
    .bind(row.site_id).first<{ name: string }>();
  const message = formatJourney({
    siteName: site?.name || row.site_id,
    kind,
    event: row.event,
    userId: row.user_id || session?.user_id || null,
    visitorId: row.visitor_id,
    source: session?.source ?? row.utm_source,
    medium: session?.medium ?? row.utm_medium,
    campaign: session?.campaign ?? row.utm_campaign,
    referrer: session?.referrer ?? row.referrer,
    channel: session?.channel ?? null,
    entry: session?.entry_page ?? row.path,
    exit: session?.exit_page ?? row.path,
    country: session?.country ?? row.country,
    device: session?.device_type ?? row.device_type,
    revenue: row.revenue,
    currency: row.currency,
    reason: reasonFrom(row),
    steps,
  });

  await db.prepare(`
    INSERT OR IGNORE INTO journey_notices (
      notice_id, site_id, eid, visitor_id, session_id, user_id, kind, event,
      revenue, currency, source, medium, campaign, referrer, channel,
      entry_page, exit_page, country, device_type, path, message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.eid, row.site_id, row.eid, row.visitor_id, row.session_id,
    row.user_id || session?.user_id || null, kind, row.event,
    row.revenue, row.currency,
    session?.source ?? row.utm_source, session?.medium ?? row.utm_medium,
    session?.campaign ?? row.utm_campaign, session?.referrer ?? row.referrer, session?.channel ?? null,
    session?.entry_page ?? row.path, session?.exit_page ?? row.path,
    session?.country ?? row.country, session?.device_type ?? row.device_type,
    JSON.stringify(steps), message, Date.now(),
  ).run();
}

async function deliverPending(db: D1Database): Promise<void> {
  const hook = await db.prepare('SELECT value FROM instance_settings WHERE key = ?')
    .bind(NOTIFY_WEBHOOK_KEY).first<{ value: string }>();
  const url = hook?.value ? normalizeWebhook(hook.value) : null;
  if (!url) return;
  const pending = await db.prepare(
    'SELECT notice_id, message FROM journey_notices WHERE notified_at IS NULL ORDER BY created_at LIMIT 10',
  ).all<{ notice_id: string; message: string }>();
  for (const row of pending.results) {
    const ok = await postWebhook(url, row.message);
    if (!ok) return;
    await db.prepare('UPDATE journey_notices SET notified_at = ? WHERE notice_id = ?')
      .bind(Date.now(), row.notice_id).run();
  }
}

async function postWebhook(url: string, text: string): Promise<boolean> {
  const host = new URL(url).hostname;
  const feishu = /feishu\.cn$|larksuite\.com$|larkoffice\.com$/.test(host);
  const body = feishu
    ? { msg_type: 'text', content: { text } }
    : { text };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    console.error('journey webhook', err);
    return false;
  }
}

export interface JourneyNotice {
  notice_id: string;
  site_id: string;
  visitor_id: string;
  user_id: string | null;
  kind: string;
  event: string;
  revenue: number | null;
  currency: string | null;
  source: string | null;
  medium: string | null;
  channel: string | null;
  entry_page: string | null;
  exit_page: string | null;
  country: string | null;
  device_type: string | null;
  path: JourneyStep[];
  message: string;
  created_at: number;
  notified_at: number | null;
}

export async function listJourneys(db: D1Database, siteId: string, kind: string | null, limit: number): Promise<JourneyNotice[]> {
  const capped = Math.min(Math.max(limit, 1), 50);
  const sql = kind === 'order' || kind === 'failed'
    ? `SELECT * FROM journey_notices WHERE site_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM journey_notices WHERE site_id = ? ORDER BY created_at DESC LIMIT ?`;
  const stmt = kind === 'order' || kind === 'failed'
    ? db.prepare(sql).bind(siteId, kind, capped)
    : db.prepare(sql).bind(siteId, capped);
  const rows = await stmt.all<JourneyNotice & { path: string }>();
  return rows.results.map((r) => ({
    ...r,
    path: parseSteps(r.path),
  }));
}

function parseSteps(raw: string): JourneyStep[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => s && typeof s.event === 'string' && typeof s.path === 'string' && typeof s.ts === 'number');
  } catch {
    return [];
  }
}
