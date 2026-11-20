/**
 * Minimal dual-format LLM client (PROJECT_PLAN.md §13 — AI analysis reports).
 *
 * Supports two on-the-wire formats the deployer picks in console settings:
 *   - 'anthropic'  → POST {base}/v1/messages, `x-api-key` + `anthropic-version`,
 *                    response `content[].text`.
 *   - 'openai'     → POST {base}/chat/completions, `Authorization: Bearer`,
 *                    response `choices[0].message.content`. This covers OpenAI
 *                    itself and every OpenAI-compatible endpoint (DeepSeek,
 *                    OpenRouter, local vLLM/Ollama, …), so `base` is fully
 *                    user-configurable.
 *
 * The provider, base URL, model name and API key are all supplied by the
 * deployer (stored in instance_settings, edited via the console). No secret is
 * ever written into a repo file (§21); the key lives only in the deployer's own
 * D1 and is never returned to the browser.
 */

export type AiProvider = 'openai' | 'anthropic';

export interface AiConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Sensible default base URLs when the deployer leaves the field blank. */
export const DEFAULT_BASE_URL: Record<AiProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

export class LlmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Read a bounded slice of the provider's error body for diagnostics (never the
 *  key — only the upstream's own message), so the console can show *why* a call
 *  failed (bad key, unknown model, rate limit) instead of a bare 500. */
async function errorText(res: Response): Promise<string> {
  let body = '';
  try { body = (await res.text()).slice(0, 500); } catch { /* ignore */ }
  return providerMessage(body) || body || res.statusText || `HTTP ${res.status}`;
}

function rawKey(apiKey: string): string {
  return apiKey.replace(/^Bearer\s+/i, '').trim();
}

/** Kie rejects a raw x-api-key and reports that as HTTP 200 `{code, msg}`.
 *  Official Anthropic keeps the raw key in x-api-key only. */
function anthropicHeaders(base: string, apiKey: string): Record<string, string> {
  const key = rawKey(apiKey);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': key,
  };
  let host = '';
  try { host = new URL(base).hostname; } catch { host = ''; }
  if (host === 'kie.ai' || host.endsWith('.kie.ai')) {
    headers.authorization = `Bearer ${key}`;
    headers['x-api-key'] = `Bearer ${key}`;
  }
  return headers;
}

/** Kie answers `{code, msg}` with HTTP 200. Pull that message out so the
 *  console does not report a successful empty body. */
function providerMessage(body: string): string {
  try {
    const data = JSON.parse(body) as { code?: number; msg?: string; error?: { message?: string } };
    if (typeof data.msg === 'string' && data.msg && data.code !== undefined && data.code !== 200) return data.msg;
    if (data.error?.message) return data.error.message;
  } catch { /* not json */ }
  return '';
}

function textFrom(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const row = data as {
    content?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    data?: unknown;
  };
  if (typeof row.content === 'string') return row.content.trim();
  if (Array.isArray(row.content)) {
    const text = row.content.map((block) => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object') return '';
      const part = block as { type?: string; text?: string };
      return part.type === 'thinking' ? '' : (part.text ?? '');
    }).join('');
    if (text.trim()) return text.trim();
  }
  const message = row.choices?.[0]?.message?.content;
  if (typeof message === 'string') return message.trim();
  if (Array.isArray(message)) {
    return message.map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text?: string }).text ?? '') : '')).join('').trim();
  }
  if (row.data && row.data !== data) return textFrom(row.data);
  return '';
}

/**
 * One-shot completion. Returns the assistant's text. Throws LlmError on a
 * non-2xx upstream response (status carried through so the caller can map it).
 */
export async function callLLM(cfg: AiConfig, system: string, user: string, maxTokens = 2200): Promise<string> {
  const base = (cfg.baseUrl || DEFAULT_BASE_URL[cfg.provider]).replace(/\/+$/, '');

  if (cfg.provider === 'anthropic') {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(base, cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new LlmError(res.status, providerMessage(body) || body.slice(0, 500) || `HTTP ${res.status}`);
    const failure = providerMessage(body);
    if (failure) throw new LlmError(502, failure);
    let data: unknown = null;
    try { data = JSON.parse(body); } catch { throw new LlmError(502, 'model returned a non-JSON body'); }
    const text = textFrom(data);
    if (!text) throw new LlmError(502, 'empty response from model');
    return text;
  }

  // openai-compatible
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${rawKey(cfg.apiKey)}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new LlmError(res.status, providerMessage(body) || body.slice(0, 500) || `HTTP ${res.status}`);
  const failure = providerMessage(body);
  if (failure) throw new LlmError(502, failure);
  let data: unknown = null;
  try { data = JSON.parse(body); } catch { throw new LlmError(502, 'model returned a non-JSON body'); }
  const text = textFrom(data);
  if (!text) throw new LlmError(502, 'empty response from model');
  return text;
}
