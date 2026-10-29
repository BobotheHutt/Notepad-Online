// Noteshack's online translator (worker/index.js), run here with a stand-in
// for Workers AI: who it answers, what it takes, what it says back.
import { test, expect } from '@playwright/test';
import worker, { Budget, DAY_TOKENS, tokens } from '../worker/index.js';

const ORIGIN = 'https://noteshack.org';
const ask = (body, { origin = ORIGIN, method = 'POST', path = '/translate' } = {}, env) => worker.fetch(new Request('https://api.noteshack.org' + path, {
  method, headers: Object.assign({ 'content-type': 'application/json' }, origin ? { origin } : {}), body: method === 'POST' ? JSON.stringify(body) : undefined
}), env);
const ai = (fn) => ({ AI: { run: async (model, q) => fn(model, q) } });
const good = ai((model, q) => ({ translated_text: q.target_lang + ':' + q.text }));

test.skip(({ browserName }) => browserName !== 'chromium', 'no browser needed: once is enough');

test('translates for noteshack.org, and only for it', async () => {
  const r = await ask({ from: 'en', to: 'sv', texts: ['Hello there.', '123'] }, {}, good);
  expect(r.status).toBe(200);
  expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(await r.json()).toEqual({ texts: ['sv:Hello there.', '123'] });
  expect((await ask({ from: 'en', to: 'sv', texts: ['Hi'] }, { origin: 'https://example.com' }, good)).status).toBe(403);
  expect((await ask({ from: 'en', to: 'sv', texts: ['Hi'] }, { origin: null }, good)).status).toBe(403);
  const pre = await ask(null, { method: 'OPTIONS' }, good);
  expect(pre.status).toBe(204);
  expect(pre.headers.get('access-control-allow-methods')).toBe('POST');
});

test('turns away what it does not take', async () => {
  for (const body of [{ from: 'en', to: 'xx', texts: ['Hi'] }, { from: 'en', to: 'en', texts: ['Hi'] }, { from: 'en', to: 'sv', texts: [] },
    { from: 'en', to: 'sv', texts: Array(33).fill('Hi') }, { from: 'en', to: 'sv', texts: ['a'.repeat(2001)] },
    { from: 'en', to: 'sv', texts: Array(7).fill('a'.repeat(1900)) }, { from: 'en', to: 'sv', texts: [5] }]) {
    expect((await ask(body, {}, good)).status).toBe(400);
  }
  expect((await ask(null, { path: '/other' }, good)).status).toBe(404);
});

test('says when the day’s allowance or a visitor’s limit is reached', async () => {
  const spent = ai(() => { throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); });
  const r = await ask({ from: 'en', to: 'sv', texts: ['Hi'] }, {}, spent);
  expect(r.status).toBe(429);
  expect(await r.json()).toEqual({ error: 'limit' });
  // a visitor's limit is "busy" (the app waits and tries again), not the day's
  const limited = Object.assign({ LIMIT: { limit: async () => ({ success: false }) } }, good);
  const busy = await ask({ from: 'en', to: 'sv', texts: ['Hi'] }, {}, limited);
  expect(busy.status).toBe(429);
  expect(await busy.json()).toEqual({ error: 'busy' });
  const broken = ai(() => { throw new Error('model error'); });
  expect((await ask({ from: 'en', to: 'sv', texts: ['Hi'] }, {}, broken)).status).toBe(502);
});

// the real Budget, with its storage kept in memory: what Cloudflare runs
const budget = () => {
  const kept = new Map();
  const b = new Budget({ storage: { get: async (k) => kept.get(k), put: async (k, v) => { kept.set(k, v); } } });
  const stub = { fetch: (url, init) => b.fetch(new Request(url, init)) };
  return { kept, BUDGET: { idFromName: (n) => n, get: (id) => { expect(id).toBe('translate'); return stub; } } };
};

test('stops translating for the day once a dollar is spent', async () => {
  // $1 at $0.342 a million tokens
  expect(DAY_TOKENS).toBe(2923976);
  // a token for 3 bytes, plus 4: English is counted high, Chinese about right
  expect(tokens('Good morning, how are you?')).toBe(13);
  expect(tokens('早上好')).toBe(7);

  const { kept, BUDGET } = budget();
  const env = Object.assign({ BUDGET }, good);
  const day = new Date().toISOString().slice(0, 10);
  const r = await ask({ from: 'en', to: 'sv', texts: ['Hello there.', '123'] }, {}, env);
  expect(r.status).toBe(200);
  // the text in and as much again out (the number is not counted), then the
  // longer translation's extra
  const asked = tokens('Hello there.');
  expect(kept.get('today')).toEqual({ day, used: 2 * asked + tokens('sv:Hello there.') - asked });

  // nearly spent: what would pass the budget is turned away, and not counted
  kept.set('today', { day, used: DAY_TOKENS - 10 });
  const over = await ask({ from: 'en', to: 'sv', texts: ['Hello there.'] }, {}, env);
  expect(over.status).toBe(429);
  expect(await over.json()).toEqual({ error: 'limit' });
  expect(kept.get('today').used).toBe(DAY_TOKENS - 10);
  // a day later it starts again from nothing
  kept.set('today', { day: '2000-01-01', used: DAY_TOKENS });
  expect((await ask({ from: 'en', to: 'sv', texts: ['Hello there.'] }, {}, env)).status).toBe(200);
  expect(kept.get('today').day).toBe(day);
  // no budget answering: nothing is translated
  const down = Object.assign({ BUDGET: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error('down'); } }) } }, good);
  expect((await ask({ from: 'en', to: 'sv', texts: ['Hi'] }, {}, down)).status).toBe(502);
});

test('a problem report is filed on GitHub, shown as written; a bot’s is dropped', async () => {
  const filed = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    filed.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ html_url: 'https://github.com/BobotheHutt/Noteshack/issues/7' }), { status: 201 });
  };
  try {
    const env = Object.assign({ GITHUB_TOKEN: 'key' }, good);
    const send = (body) => ask(body, { path: '/report' }, env);
    const r = await send({ what: 'The PDF would not save.\n~~~\n@someone ![x](https://example.com/x.png)', steps: 'Clicked Download.', version: '2026.10.29-48', browser: 'Chrome 141 on Windows', lang: 'es' });
    // the other fields are not shown as written, so only plain characters stay in them
    await send({ what: 'The PDF would not save at all.', version: '1 @someone', browser: '![x](https://example.com/x.png) **Edge**', lang: '<b>es</b>' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: 'https://github.com/BobotheHutt/Noteshack/issues/7' });
    expect(filed.length).toBe(2);
    expect(filed[1].body.body).toContain('**Noteshack** 1 someone · **Browser** x(httpsexample.comx.png) Edge · **App language** besb');
    expect(filed[1].body.body).not.toMatch(/@|!\[|<b>/);
    filed.splice(1);
    expect(filed[0].url).toBe('https://api.github.com/repos/BobotheHutt/Noteshack/issues');
    expect(filed[0].auth).toBe('Bearer key');
    expect(filed[0].body.title).toBe('Report: The PDF would not save. ~~~ @someone ![x](https://example.com/x.png)');
    const body = filed[0].body.body;
    // what they wrote sits in a block GitHub shows as it is, which it cannot close
    expect(body).toContain('~~~text\nThe PDF would not save.\n∼∼∼\n@someone');
    expect(body.match(/^~~~/gm).length).toBe(4);
    expect(body).toContain('**Noteshack** 2026.10.29-48 · **Browser** Chrome 141 on Windows · **App language** es');
    // a bot's (the hidden field filled in): thanked, not filed
    expect((await send({ what: 'Buy cheap things here now', website: 'http://spam.example' })).status).toBe(200);
    // too short, too long, not text
    for (const b of [{ what: 'broken' }, { what: 'x'.repeat(4001) }, { what: 'The PDF would not save.', steps: 5 }]) expect((await send(b)).status).toBe(400);
    expect(filed.length).toBe(1);
    // GitHub refusing it
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    expect((await send({ what: 'The PDF would not save at all.' })).status).toBe(502);
    // its own, stricter limit
    const limited = Object.assign({ REPORTS: { limit: async () => ({ success: false }) } }, env);
    expect((await ask({ what: 'The PDF would not save at all.' }, { path: '/report' }, limited)).status).toBe(429);
  } finally {
    globalThis.fetch = real;
  }
});
