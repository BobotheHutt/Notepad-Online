// A new release while the tab is open: never on load (loading gets the
// newest), every hour after, or when About's "Check for updates" is pressed.
import { test, expect } from './helpers.mjs';

// the page's own requests, so sw.js can be stood in for
test.use({ serviceWorkers: 'block' });

const release = (p, n) => p.route(/\/sw\.js$/, (route) => route.fulfill({ contentType: 'text/javascript', body: "const CACHE = 'noteshack-v" + n + "';" }));
const current = (p) => p.evaluate(() => Number(document.querySelector('script[src*="app.js"]').src.match(/v=(\d+)/)[1]));

test('a tab left open hears of a new release within the hour, not on load', async ({ page: p, errors }) => {
  await p.clock.install();
  await p.goto('/');
  await p.waitForSelector('body.ready');
  await release(p, (await current(p)) + 1);
  await p.clock.runFor(30 * 60000);
  await expect(p.locator('.update-note')).toHaveCount(0);
  await p.clock.runFor(31 * 60000);
  await expect(p.locator('.update-note')).toContainText('A new version of Noteshack is ready.');
  await expect(p.locator('.update-note').getByRole('button', { name: 'Reload' })).toBeVisible();
  await p.locator('.update-note').getByRole('button', { name: 'Close' }).click();
  await expect(p.locator('.update-note')).toHaveCount(0);
  // shown once: not again an hour later
  await p.clock.runFor(61 * 60000);
  await expect(p.locator('.update-note')).toHaveCount(0);
});

test('About checks for updates when asked', async ({ app: p }) => {
  const n = await current(p);
  await release(p, n);
  await p.locator('.menu', { has: p.locator('[data-action="about"]') }).locator('.menu-btn').click();
  await p.click('.menu.open [data-action="about"]');
  const line = p.locator('dialog[open] .update-line');
  await line.getByRole('button', { name: 'Check for updates' }).click();
  await expect(line).toContainText('You have the newest version.');
  await p.unroute(/\/sw\.js$/);
  await release(p, n + 1);
  await line.getByRole('button', { name: 'Check for updates' }).click();
  await expect(line).toContainText('A new version of Noteshack is ready.');
  // reloading saves first, then loads the new release
  await Promise.all([p.waitForEvent('load'), line.getByRole('button', { name: 'Reload' }).click()]);
});
