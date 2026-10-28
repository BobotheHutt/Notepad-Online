// TEMPORARY: evidence for two WebKit-only failures. Removed before going live.
import { test, openFile } from './helpers.mjs';
test('debug: TIFF page 1 read alone', async ({ app: p, browserName }) => {
  await openFile(p, 'scan-2pages.tif');
  await p.click('[data-pdf-tool="edit"]');
  const bb = await p.locator('.pdf-page').first().boundingBox();
  await p.mouse.click(bb.x + bb.width * 0.3, bb.y + bb.height * 0.2);
  await p.waitForSelector('.pdf-reading', { timeout: 10000 }).catch(() => {});
  await p.waitForSelector('.pdf-reading', { state: 'detached', timeout: 180000 }).catch(() => {});
  await p.waitForTimeout(1000);
  await p.keyboard.press('Escape');
  const alone = await p.evaluate(() => [...document.querySelectorAll('.pdf-page')].map((pg) => [...pg.querySelectorAll('.pdf-conv')].map((n) => n.textContent).join(' ').slice(0, 80)));
  console.log(browserName, 'ALONE', JSON.stringify(alone), 'cores', await p.evaluate(() => navigator.hardwareConcurrency));
  // then page 2 on its own
  const bb2 = await p.locator('.pdf-page').nth(1).boundingBox();
  await p.locator('.pdf-page').nth(1).scrollIntoViewIfNeeded();
  const b2 = await p.locator('.pdf-page').nth(1).boundingBox();
  await p.mouse.click(b2.x + b2.width * 0.3, b2.y + b2.height * 0.2);
  await p.waitForSelector('.pdf-reading', { timeout: 10000 }).catch(() => {});
  await p.waitForSelector('.pdf-reading', { state: 'detached', timeout: 180000 }).catch(() => {});
  await p.waitForTimeout(1000);
  const both = await p.evaluate(() => [...document.querySelectorAll('.pdf-page')].map((pg) => [...pg.querySelectorAll('.pdf-conv')].map((n) => n.textContent).join(' ').slice(0, 80)));
  console.log(browserName, 'ONE BY ONE', JSON.stringify(both), bb2 ? '' : '');
});

test('debug: offline', async ({ app: p, context, browserName }) => {
  await p.click('#editor'); await p.keyboard.type('Offline words');
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload(); await p.waitForSelector('body.ready');
  const before = await p.evaluate(async () => ({ controlled: !!navigator.serviceWorker.controller, caches: await caches.keys() }));
  await context.setOffline(true);
  const off = await p.evaluate(async () => {
    const out = {};
    for (const u of ['./', './index.html', './js/app.js', './styles.css']) { try { const r = await fetch(u); out[u] = r.status + ' ' + (await r.text()).length; } catch (e) { out[u] = 'ERR ' + e.message; } }
    return out;
  });
  let reload = 'ok';
  try { await p.reload({ timeout: 15000 }); await p.waitForSelector('body.ready', { timeout: 15000 }); } catch (e) { reload = 'FAILED ' + e.message.split('\n')[0]; }
  await context.setOffline(false);
  console.log(browserName, 'OFFLINE', JSON.stringify(before), JSON.stringify(off), reload);
});
