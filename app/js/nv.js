// NVIDIA API client (through the local proxy) with automatic model fallback.
import { settings, SUGGESTED_MODELS, DEFAULT_MODEL } from './settings.js';
import { toast } from './util.js';

const isGone = (status, msg) => status === 404 || status === 410 || status === 504 || /end of life|no longer available|not found/i.test(msg);
const errText = (d, status) => d.error?.message || (typeof d.error === 'string' ? d.error : '') || d.detail || d.title || `AI request failed (${status})`;

async function once(body, key, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Frame-Client': '1', ...(key ? { 'X-NVIDIA-Key': key } : {}) },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, status: 504, data: { error: 'The AI took too long to answer.' } };
    throw e;
  } finally { clearTimeout(timer); }
}

/** Chat completion. messages may contain image parts. Returns the text content. */
export async function nvChat(messages, { maxTokens = 4096, think = null, vision = false, timeoutMs = 120000, temperature } = {}) {
  const s = settings.get();
  const chosen = s.model || DEFAULT_MODEL;
  let order = [chosen, ...SUGGESTED_MODELS.filter((m) => m !== chosen)];
  if (vision) order = order.filter((m) => /vl|vision/i.test(m)).concat(order.filter((m) => !/vl|vision/i.test(m)));
  const deep = think ?? s.deepThink;
  let lastErr = '';
  for (const model of order) {
    const r = await once({ model, messages, temperature: temperature ?? s.temperature ?? 0.2, top_p: 0.9, max_tokens: deep ? Math.max(maxTokens, 8192) : maxTokens, stream: false, chat_template_kwargs: { enable_thinking: !!deep } }, s.key, timeoutMs);
    if (r.ok) {
      if (model !== chosen && !vision) { settings.set({ model }); toast(`“${chosen}” is unavailable - switched to ${model}`); }
      const m = r.data.choices?.[0]?.message || {};
      return m.content || m.reasoning_content || '';
    }
    lastErr = errText(r.data, r.status);
    if (!isGone(r.status, lastErr) && !/image|vision|multimodal/i.test(lastErr)) break;
  }
  throw new Error(lastErr || 'AI request failed');
}

/** Extract a JSON object from model text. */
export function parseJSON(text) {
  let s = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}
