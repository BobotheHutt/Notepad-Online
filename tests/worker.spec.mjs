// Noteshack's online translator (worker/index.js), run here with a stand-in
// for Workers AI: who it answers, what it takes, what it says back.
import { test, expect } from '@playwright/test';
import worker from '../worker/index.js';

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
  const limited = Object.assign({ LIMIT: { limit: async () => ({ success: false }) } }, good);
  expect((await ask({ from: 'en', to: 'sv', texts: ['Hi'] }, {}, limited)).status).toBe(429);
  const broken = ai(() => { throw new Error('model error'); });
  expect((await ask({ from: 'en', to: 'sv', texts: ['Hi'] }, {}, broken)).status).toBe(502);
});
