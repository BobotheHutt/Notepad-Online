/* Noteshack's online service: api.noteshack.org, a Cloudflare Worker.
   Answers only noteshack.org, with a limit for each visitor and a daily
   spending cap on translating; nothing is kept or logged (the cap keeps only
   a count of today's text, in the Durable Object Budget).

   POST /translate  { from, to, texts: [string] }  →  { texts: [string] }
     Used only when someone picks "Online" in Tools → Translate. The text is
     translated by Workers AI (Meta's M2M-100, MIT License) and sent back.
   POST /report  { what, steps, version, browser, lang, website }  →  { url }
     Tools → Report a problem: filed as an issue on Noteshack's GitHub
     (public), with the GitHub key (GITHUB_TOKEN) kept here. `website` is a
     field people never see; a report with it filled in came from a bot, and
     is thanked and dropped.

   Errors: { error: 'busy' } (429: too many requests from this visitor this
   minute; try again shortly), { error: 'limit' } (429: today's budget is
   spent, until midnight UTC), { error: 'bad' } (400), { error: 'failed' }
   (502).

   Deployed by tools/worker.py, with the AI binding (AI), rate limits
   (LIMIT; REPORTS, stricter), the budget (BUDGET) and the GitHub key. */

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
const REPO = 'BobotheHutt/Noteshack';

// The daily cap. The account is on Workers Paid, so Workers AI past its free
// daily allowance is billed, not stopped. M2M-100 costs $0.342 a million
// tokens, in and out alike; the cap counts from $0 (the free allowance is
// shared with another project), so $1 is about 2.9 million tokens a day.
const BUDGET_USD = 1;
const PRICE = 0.342 / 1e6;
export const DAY_TOKENS = Math.floor(BUDGET_USD / PRICE);
// The model does not say how many tokens it used, so they are estimated on
// the high side: a token for every 3 bytes of UTF-8 (about 4 letters of a
// European language make one; a Chinese or Hindi letter is 3 bytes, about a
// token), and 4 more for each text's start, end and language.
export const tokens = (text) => Math.ceil(new TextEncoder().encode(text).length / 3) + 4;

/* Today's spending, as tokens: one for the whole service (BUDGET, named
   'translate'). POST { tokens, force } adds them and answers { ok: true },
   or, unless forced, { ok: false } when they would pass the day's budget and
   adds nothing. A Durable Object takes one request at a time, so the count
   is exact. */
export class Budget {
  constructor(ctx) { this.storage = ctx.storage; }
  async fetch(req) {
    const { tokens: n, force } = await req.json();
    const day = new Date().toISOString().slice(0, 10);
    const today = await this.storage.get('today');
    const used = today && today.day === day ? today.used : 0;
    if (!force && used + n > DAY_TOKENS) return Response.json({ ok: false });
    await this.storage.put('today', { day, used: used + n });
    return Response.json({ ok: true });
  }
}

const spend = async (env, n, force = false) => {
  if (!env.BUDGET) return true;
  const r = await env.BUDGET.get(env.BUDGET.idFromName('translate')).fetch('https://budget/', { method: 'POST', body: JSON.stringify({ tokens: n, force }) });
  return (await r.json()).ok;
};

function answer(body, status, origin) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Origin' };
  if (origin) Object.assign(headers, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
  return new Response(body == null ? null : JSON.stringify(body), { status, headers });
}

// one line, short, for a title
const line = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
// the version, browser and language: letters, digits and a little
// punctuation, so they cannot become links, pictures or mentions
const plain = (s, n) => line(String(s).replace(/[^\p{L}\p{N} .,()\-]/gu, ''), n);
// what people wrote, shown as written: in a block GitHub does not format,
// so it cannot make links, pictures or mentions
const block = (s) => '~~~text\n' + String(s).replace(/~{3,}/g, (m) => m.replace(/~/g, '∼')).trim() + '\n~~~';

async function report(q, env, origin) {
  const { what, steps = '', version = '', browser = '', lang = '', website = '' } = q || {};
  if (website) return answer({ url: null }, 200, origin);
  if (typeof what !== 'string' || what.trim().length < 10 || what.length > 4000 || typeof steps !== 'string' || steps.length > 4000 ||
    [version, browser, lang].some((v) => typeof v !== 'string' || v.length > 200)) return answer({ error: 'bad' }, 400, origin);
  const body = [
    '**What happened**', block(what),
    steps.trim() ? '**What they were doing**\n' + block(steps) : '',
    '**Noteshack** ' + plain(version, 40) + ' · **Browser** ' + plain(browser, 120) + ' · **App language** ' + plain(lang, 10),
    '_Sent from the app (Tools → Report a problem)._'
  ].filter(Boolean).join('\n\n');
  const res = await fetch('https://api.github.com/repos/' + REPO + '/issues', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'noteshack-api', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Report: ' + line(what, 70), body })
  });
  if (!res.ok) return answer({ error: 'failed' }, 502, origin);
  const issue = await res.json();
  return answer({ url: issue.html_url }, 200, origin);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = ORIGINS.includes(req.headers.get('origin')) ? req.headers.get('origin') : null;
    if (url.pathname !== '/translate' && url.pathname !== '/report') return answer({ error: 'bad' }, 404, origin);
    if (!origin) return answer({ error: 'bad' }, 403, null);
    if (req.method === 'OPTIONS') return answer(null, 204, origin);
    if (req.method !== 'POST') return answer({ error: 'bad' }, 405, origin);

    const who = req.headers.get('cf-connecting-ip') || 'unknown';
    const limiter = url.pathname === '/report' ? env.REPORTS : env.LIMIT;
    if (limiter) {
      const { success } = await limiter.limit({ key: who });
      if (!success) return answer({ error: 'busy' }, 429, origin);
    }

    let q;
    try { q = await req.json(); } catch (e) { return answer({ error: 'bad' }, 400, origin); }
    if (url.pathname === '/report') {
      try { return await report(q, env, origin); } catch (e) { return answer({ error: 'failed' }, 502, origin); }
    }
    const { from, to, texts } = q || {};
    if (!LANGS.includes(from) || !LANGS.includes(to) || from === to || !Array.isArray(texts) || !texts.length || texts.length > MAX_TEXTS ||
      texts.some((t) => typeof t !== 'string' || t.length > MAX_TEXT) || texts.reduce((n, t) => n + t.length, 0) > MAX_TOTAL) {
      return answer({ error: 'bad' }, 400, origin);
    }

    // the text in, and as much again coming out, is held against the day's
    // budget first; what a longer translation used past that is added after
    const words = texts.filter((t) => /\p{L}/u.test(t));
    const asked = words.reduce((n, t) => n + tokens(t), 0);
    try {
      if (asked && !(await spend(env, 2 * asked))) return answer({ error: 'limit' }, 429, origin);
    } catch (e) { return answer({ error: 'failed' }, 502, origin); }

    try {
      const out = await Promise.all(texts.map(async (text) => {
        if (!/\p{L}/u.test(text)) return text;
        const r = await env.AI.run(MODEL, { text, source_lang: from, target_lang: to });
        return String((r && r.translated_text) || '');
      }));
      const more = out.filter((t, i) => /\p{L}/u.test(texts[i])).reduce((n, t) => n + tokens(t), 0) - asked;
      if (more > 0) await spend(env, more, true).catch(() => {});
      return answer({ texts: out }, 200, origin);
    } catch (e) {
      // Workers AI turning it away for its own limits
      const limit = /neuron|allocation|quota|capacity|429|4006/i.test(String((e && e.message) || e));
      return answer({ error: limit ? 'limit' : 'failed' }, limit ? 429 : 502, origin);
    }
  }
};
