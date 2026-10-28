// Accessibility, privacy, small screens and offline.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test, expect, openFile, waitToast } from './helpers.mjs';

const AXE = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
async function axe(p) {
  // evaluated, not added as a script tag: the security policy (rightly) blocks inline scripts
  await p.evaluate(AXE);
  return p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations
    .map((v) => v.id + ': ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' ; ')));
}

test('no accessibility problems: editor, menus, a read scan', async ({ app: p }) => {
  expect(await axe(p)).toEqual([]);
  await p.click('.menu-btn:has-text("File")');
  expect(await axe(p)).toEqual([]);
  await p.keyboard.press('Escape');
  await openFile(p, 'scan.pdf');
  await p.click('label[for="pdf-readall"]');
  await waitToast(p, /whole document is read/);
  await p.click('[data-pdf-tool="edit"]');
  expect(await axe(p)).toEqual([]);
});

test('the only outside site contacted is the font CDN', async ({ app: p, context }) => {
  const hosts = new Set();
  context.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol)) hosts.add(u.host); });
  await p.reload(); await p.waitForSelector('body.ready');
  await p.click('#editor'); await p.keyboard.type('Some words');
  await openFile(p, 'scan.pdf');
  await p.click('label[for="pdf-readall"]');
  await waitToast(p, /whole document is read/);
  await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  const base = new URL(test.info().project.use.baseURL).host;
  expect([...hosts].filter((h) => h !== base && h !== 'cdn.jsdelivr.net')).toEqual([]);
});

test('no sideways scrolling on small screens', async ({ app: p }) => {
  for (const width of [320, 390, 768]) {
    await p.setViewportSize({ width, height: 800 });
    await p.waitForTimeout(300);
    expect(await p.evaluate(() => document.documentElement.scrollWidth), 'at ' + width + 'px').toBeLessThanOrEqual(width);
  }
  await openFile(p, 'letter.pdf');
  for (const width of [320, 390]) {
    await p.setViewportSize({ width, height: 800 });
    await p.waitForTimeout(300);
    expect(await p.evaluate(() => document.documentElement.scrollWidth), 'PDF at ' + width + 'px').toBeLessThanOrEqual(width);
  }
});

test('works offline once loaded', async ({ app: p, context, browserName }) => {
  // In the test tool's WebKit, "offline" blocks requests before the app's
  // offline cache can answer them: checked on GitHub, the cache was installed
  // and in control, yet every request failed. Chrome and Firefox serve them.
  test.skip(browserName === 'webkit', 'the test tool cannot emulate offline with a service worker in WebKit');
  await p.click('#editor'); await p.keyboard.type('Written before going offline');
  await expect(p.locator('#save-status')).toHaveText('Saved in Noteshack', { timeout: 10000 });
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload(); await p.waitForSelector('body.ready');
  await context.setOffline(true);
  await p.reload(); await p.waitForSelector('body.ready', { timeout: 15000 });
  await expect(p.locator('#editor')).toContainText('Written before going offline');
  await context.setOffline(false);
});

test('the security policy blocks injected scripts and outside sites', async ({ page: p }) => {
  const blocked = [];
  await p.exposeFunction('__seen', (v) => blocked.push(v));
  await p.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__seen(e.violatedDirective)));
  await p.goto('/'); await p.waitForSelector('body.ready');
  const ran = await p.evaluate(async () => {
    const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; document.body.append(s);
    const d = document.createElement('div'); d.innerHTML = '<img src="x" onerror="window.__ran2 = 1">'; document.body.append(d);
    let fetched = true;
    try { await fetch('https://example.com/'); } catch (e) { fetched = false; }
    await new Promise((r) => setTimeout(r, 300));
    return [window.__ran, window.__ran2, fetched];
  });
  expect(ran).toEqual([undefined, undefined, false]);
  expect(blocked).toEqual(expect.arrayContaining(['script-src-elem', 'script-src-attr', 'connect-src']));
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });
  test('says why the app needs it, instead of a dead page', async ({ page: p }) => {
    await p.goto('/');
    await expect(p.locator('.noscript')).toBeVisible();
    await expect(p.locator('.noscript h2')).toHaveText('Noteshack needs JavaScript');
    await p.screenshot({ path: test.info().outputPath('noscript.png') });
  });
});

test('menus open over the toolbars, PDF ones included', async ({ app: p }) => {
  const menuOnTop = () => p.evaluate(() => {
    const m = [...document.querySelectorAll('.menu-pop')].find((x) => x.offsetParent);
    const r = m.getBoundingClientRect();
    return [0.2, 0.5, 0.8].every((f) => m.contains(document.elementFromPoint(r.left + r.width * f, r.top + 30)));
  });
  await p.click('.menu-btn:has-text("File")');
  expect(await menuOnTop()).toBe(true);
  await p.keyboard.press('Escape');
  await openFile(p, 'scan.jpg');
  await p.click('.menu-btn:has-text("File")');
  expect(await menuOnTop()).toBe(true);
});
