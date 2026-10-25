import { test, expect, openFile, waitToast, newestDoc } from './helpers.mjs';

const converted = (p) => p.evaluate(() => [...document.querySelectorAll('.pdf-page')].map((pg) => pg.querySelectorAll('.pdf-conv').length));

test('clicking a scanned page reads that page only', async ({ app: p }) => {
  await openFile(p, 'multi-scan.pdf');
  await expect(p.locator('#pdf-readall-wrap')).toBeVisible();
  await expect(p.locator('#pdf-readall')).not.toBeChecked();
  await p.click('[data-pdf-tool="edit"]');
  const bb = await p.locator('.pdf-page').first().boundingBox();
  await p.mouse.click(bb.x + bb.width * 0.25, bb.y + bb.height * 0.16);
  await p.waitForSelector('.pdf-reading', { timeout: 10000 });
  await p.waitForSelector('.pdf-reading', { state: 'detached', timeout: 180000 });
  await expect(p.locator('.pdf-textbox.editing')).toContainText('Full name');
  const per = await converted(p);
  expect(per[0]).toBeGreaterThan(3);
  expect(per[1]).toBe(0);
});

test('reading the whole document: straightened, turned upright, searchable, kept', async ({ app: p }) => {
  await openFile(p, 'multi-scan.pdf');
  await p.click('label[for="pdf-readall"]');
  await waitToast(p, /whole document is read/);
  const msg = await p.textContent('#toast');
  expect(msg).toMatch(/Turned 1 page the right way up/);
  const per = await converted(p);
  expect(per.every((n) => n > 2)).toBe(true);
  const text = (await p.locator('.pdf-conv').allTextContents()).join(' ');
  for (const w of ['APPLICATION', 'Example', 'Springfield', 'Phone', 'Signature']) expect(text).toContain(w);
  // background work is not an edit: undo leaves it alone
  await expect(p.locator('[data-pdf="undo"]')).toBeDisabled();
  await p.reload(); await p.waitForSelector('body.ready'); await p.waitForSelector('.pdf-page canvas');
  await expect.poll(() => converted(p)).toEqual(per);
});

test('a read scan: edit a line, check a word, download', async ({ app: p }) => {
  await openFile(p, 'scan.pdf');
  await p.click('label[for="pdf-readall"]');
  await waitToast(p, /whole document is read/);
  await p.click('[data-pdf-tool="edit"]');
  const run = p.locator('.pdf-conv', { hasText: 'Springfield' }).first();
  await run.click();
  await expect(p.locator('.pdf-textbox.editing')).toContainText('Springfield');
  await p.evaluate(() => { const n = document.querySelector('.pdf-textbox.editing'); n.textContent = n.textContent.replace('Springfield', 'Shelbyville'); });
  await p.keyboard.press('Escape');
  await expect(p.locator('.pdf-conv', { hasText: 'Shelbyville' })).toHaveCount(1);
  await p.click('[data-pdf="undo"]');
  await expect(p.locator('.pdf-conv', { hasText: 'Springfield' })).toHaveCount(1);
  await p.click('[data-pdf="redo"]');
  // right-click a word: its menu
  await p.locator('.pdf-conv', { hasText: 'Example' }).first().click({ button: 'right' });
  await expect(p.locator('.pdf-menu-item', { hasText: 'Copy word' })).toBeVisible();
  await p.keyboard.press('Escape');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  const file = test.info().outputPath('scan-out.pdf');
  await dl.saveAs(file);
  await p.setInputFiles('#file-open', file);
  await p.waitForSelector('.pdf-page canvas'); await p.waitForTimeout(800);
  expect((await newestDoc(p)).text).toContain('Shelbyville');
});

test('a fax-compressed scan (CCITT, as many office scanners save) is drawn and read', async ({ app: p }) => {
  await openFile(p, 'scan-fax.pdf');
  // drawn: the page is not blank
  const dark = await p.evaluate(() => {
    const c = document.querySelector('.pdf-page canvas');
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 100) n++;
    return n;
  });
  expect(dark).toBeGreaterThan(1000);
  await p.click('label[for="pdf-readall"]');
  await waitToast(p, /whole document is read/);
  const text = (await p.locator('.pdf-conv').allTextContents()).join(' ');
  for (const w of ['APPLICATION', 'Example', 'Springfield']) expect(text).toContain(w);
});
