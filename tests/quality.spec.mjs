// Accessibility, privacy, small screens and offline.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test, expect, openFile, waitToast } from './helpers.mjs';

const AXE = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
async function axe(p) {
  await p.addScriptTag({ content: AXE });
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

test('works offline once loaded', async ({ app: p, context }) => {
  await p.click('#editor'); await p.keyboard.type('Written before going offline');
  await expect(p.locator('#save-status')).toHaveText('Saved', { timeout: 10000 });
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload(); await p.waitForSelector('body.ready');
  await context.setOffline(true);
  await p.reload(); await p.waitForSelector('body.ready', { timeout: 15000 });
  await expect(p.locator('#editor')).toContainText('Written before going offline');
  await context.setOffline(false);
});
