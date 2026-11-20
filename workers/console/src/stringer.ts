/**
 * Market advice from the 什么值得做 MCP (stringers.io).
 *
 * The console asks for products that are already growing in the same space as
 * this site, then for a playbook that matches those words. The reply is their
 * written judgment (what it is, why it grew, what to copy). We keep the first
 * few cases. The MCP URL is a secret: it is never returned to the browser.
 */

const STOP = new Set(['www', 'com', 'app', 'ai', 'the', 'and', 'for', 'to', 'of', 'org', 'net', 'io', 'www2']);
const GENERIC = new Set(['every', 'text', 'free', 'best', 'your', 'online', 'make', 'maker', 'tool', 'tools', 'page', 'home', 'plus']);

export function searchQueries(name: string, domains: string[]): string[] {
  const host = (domains[0] || '').replace(/^www\./, '').split('.')[0] || '';
  const raw = `${name} ${host}`
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const words = raw.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
  const long = [...new Set(words)];
  const queries: string[] = [];
  const add = (q: string) => { if (q && !queries.includes(q)) queries.push(q); };
  if (long.length >= 2) add(`${long[0]} ${long[1]}`);
  for (const w of [...long].sort((a, b) => a.length - b.length)) add(w);
  return queries.slice(0, 3);
}

/** Keep the heading and the first few graded cases. Empty when nothing matched. */
export function firstCases(text: string, n = 3): string {
  const hit = text.match(/命中\s+(\d+)/);
  if (hit && hit[1] === '0') return '';
  if (/0\s*条/.test(text.slice(0, 120))) return '';
  const parts = text.split(/\n(?=\[[A-E]\])/);
  if (parts.length <= 1) return text.trim().slice(0, 1600);
  const head = parts[0].trim().split('\n')[0];
  const cases = parts.slice(1, n + 1).map((s) => s.trim());
  const count = hit ? `库里命中 ${hit[1]} 个，下面是等级最高的 ${cases.length} 个。` : '';
  return [head, count, ...cases].filter(Boolean).join('\n\n');
}

async function callTool(url: string, name: string, args: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`stringer http ${res.status}`);
  const data = await res.json() as {
    error?: { message?: string };
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  if (data.error) throw new Error(data.error.message || 'stringer error');
  const text = (data.result?.content ?? []).map((c) => c.text ?? '').join('\n').trim();
  if (data.result?.isError) throw new Error(text || 'stringer error');
  if (!text) throw new Error('stringer empty');
  return text;
}

export function cleanHint(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').slice(0, 40);
}

export async function marketAdvice(url: string, name: string, domains: string[], hint = ''): Promise<{ content: string; query: string }> {
  const typed = cleanHint(hint);
  const queries = typed ? [typed] : searchQueries(name, domains);
  const ask = '同类产品最近为什么在涨，这周能照着做的获客动作';
  let products = '';
  let used = queries[0] || name;
  for (const q of queries) {
    if (!q.includes(' ') && GENERIC.has(q) && queries.some((other) => other !== q && !GENERIC.has(other))) continue;
    const text = await callTool(url, 'products', { q, ask });
    const cases = firstCases(text);
    if (cases) { products = cases; used = q; break; }
  }
  let plays = '';
  try {
    plays = firstCases(await callTool(url, 'plays', { q: used, ask }), 2);
  } catch { /* a missing playbook still leaves the product cases */ }

  const sections = ['## 建议'];
  if (products) sections.push('### 同类里正在涨的', '每条的「怎么跟」就是能照着做的动作。收入是对方标的估算档位。', '', products);
  if (plays) sections.push('', '### 可以照着做的打法', '', plays);
  if (!products && !plays) {
    sections.push(`没有找到和「${queries.join(' / ') || name}」对得上的在涨产品。在上面填一个更普通的品类词，例如 ai video，再更新一次。`);
  }
  sections.push('', '来源：什么值得做（stringers.io）。库里没有的，上面就不会写。');
  return { content: sections.join('\n'), query: used };
}
