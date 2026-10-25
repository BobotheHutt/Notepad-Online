import { test, expect, openFile } from './helpers.mjs';

test('print shows a preview, then prints every page', async ({ app: p }) => {
  await openFile(p, 'letter.pdf');
  await p.evaluate(() => {
    window.__printed = 0;
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.tagName === 'IFRAME') {
        n.contentWindow.print = () => { window.__printed++; window.__imgs = [...n.contentDocument.images].filter((i) => i.naturalWidth > 0).length; };
      }
    }).observe(document.body, { childList: true });
  });
  await p.keyboard.press('Control+p');
  await expect(p.locator('dialog .print-page')).toHaveCount(2, { timeout: 60000 });
  await expect(p.locator('.print-num')).toHaveText(['Page 1 of 2', 'Page 2 of 2']);
  await p.click('dialog button:has-text("Print")');
  await p.waitForFunction(() => window.__printed > 0, null, { timeout: 60000 });
  expect(await p.evaluate(() => window.__imgs)).toBe(2);
});
