/* Noteshack's online translator: api.noteshack.org, a Cloudflare Worker.

   Used only when someone picks "Online" in Tools → Translate. The text is
   translated by Workers AI (Meta's M2M-100, MIT License) and sent back;
   nothing is kept or logged. Answers only noteshack.org, a few requests a
   minute for each visitor, with a cap on how much text a request holds.

   POST /translate  { from, to, texts: [string] }  →  { texts: [string] }
   Errors: { error: 'limit' } (429: too many requests, or today's free
   allowance is used up), { error: 'bad' } (400), { error: 'failed' } (502).

   Deployed by tools/worker.py, with the AI binding (AI) and a rate limit
   (LIMIT). */

const MODEL = '@cf/meta/m2m100-1.2b';
const ORIGINS = ['https://noteshack.org', 'https://www.noteshack.org'];
// the languages the model translates, as the app names them; Basque and
// Chinese written the traditional way are not among them
export const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'pl', 'sv', 'da', 'no', 'fi', 'cs', 'sk', 'hu', 'ro', 'hr', 'sl', 'et', 'lv', 'lt',
  'el', 'ru', 'uk', 'bg', 'sr', 'tr', 'ar', 'he', 'fa', 'ur', 'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'pa', 'zh', 'ja', 'ko', 'th', 'vi', 'id',
  'ms', 'tl', 'sw', 'ca', 'gl', 'ga', 'cy', 'is', 'af'];
const MAX_TEXTS = 32;
const MAX_TEXT = 2000;
const MAX_TOTAL = 12000;

function answer(body, status, origin) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Origin' };
  if (origin) Object.assign(headers, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
  return new Response(body == null ? null : JSON.stringify(body), { status, headers });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = ORIGINS.includes(req.headers.get('origin')) ? req.headers.get('origin') : null;
    if (url.pathname !== '/translate') return answer({ error: 'bad' }, 404, origin);
    if (!origin) return answer({ error: 'bad' }, 403, null);
    if (req.method === 'OPTIONS') return answer(null, 204, origin);
    if (req.method !== 'POST') return answer({ error: 'bad' }, 405, origin);

    if (env.LIMIT) {
      const { success } = await env.LIMIT.limit({ key: req.headers.get('cf-connecting-ip') || 'unknown' });
      if (!success) return answer({ error: 'limit' }, 429, origin);
    }

    let q;
    try { q = await req.json(); } catch (e) { return answer({ error: 'bad' }, 400, origin); }
    const { from, to, texts } = q || {};
    if (!LANGS.includes(from) || !LANGS.includes(to) || from === to || !Array.isArray(texts) || !texts.length || texts.length > MAX_TEXTS ||
      texts.some((t) => typeof t !== 'string' || t.length > MAX_TEXT) || texts.reduce((n, t) => n + t.length, 0) > MAX_TOTAL) {
      return answer({ error: 'bad' }, 400, origin);
    }

    try {
      const out = await Promise.all(texts.map(async (text) => {
        if (!/\p{L}/u.test(text)) return text;
        const r = await env.AI.run(MODEL, { text, source_lang: from, target_lang: to });
        return String((r && r.translated_text) || '');
      }));
      return answer({ texts: out }, 200, origin);
    } catch (e) {
      // the day's free allowance used up (the account is on the free plan,
      // so it stops rather than charging)
      const limit = /neuron|allocation|quota|capacity|429|4006/i.test(String((e && e.message) || e));
      return answer({ error: limit ? 'limit' : 'failed' }, limit ? 429 : 502, origin);
    }
  }
};
