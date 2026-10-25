// Images open in the PDF editor, read and edit like a scan, and download as
// the same kind of image, the same size in pixels.
import fs from 'node:fs';
import { test, expect, openFile, waitToast } from './helpers.mjs';

// width, height and kind of a downloaded image, as the browser reads it
async function inspect(p, file, type) {
  const bytes = [...fs.readFileSync(file)];
  return p.evaluate(async ([bytes, type]) => {
    const b = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
    return [b.width, b.height];
  }, [bytes, type]);
}

async function download(p, selector) {
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click(selector)]);
  const file = test.info().outputPath(dl.suggestedFilename());
  await dl.saveAs(file);
  return { file, name: dl.suggestedFilename() };
}

const convText = async (p) => (await p.locator('.pdf-conv').allTextContents()).join(' ');

test('a JPG: read, edit, and download as a JPG the same size, with the change in it', async ({ app: p }) => {
  await openFile(p, 'scan.jpg');
  await expect(p.locator('.pdf-page')).toHaveCount(1);
  await expect(p.locator('#pdf-readall-wrap')).toBeVisible();
  await p.click('label[for="pdf-readall"]');
  await waitToast(p, /whole document is read/);
  expect(await convText(p)).toContain('Springfield');
  await p.click('[data-pdf-tool="edit"]');
  await p.locator('.pdf-conv', { hasText: 'Springfield' }).first().click();
  await p.evaluate(() => { const n = document.querySelector('.pdf-textbox.editing'); n.textContent = n.textContent.replace('Springfield', 'Shelbyville'); });
  await p.keyboard.press('Escape');
  await expect(p.locator('.pdf-download')).toHaveAttribute('title', 'Download the JPG with your changes');
  const out = await download(p, '.pdf-download');
  expect(out.name).toBe('scan.jpg');
  expect(await inspect(p, out.file, 'image/jpeg')).toEqual([1700, 2200]);
  // opened again and read: the change is in the picture itself
  await p.setInputFiles('#file-open', out.file);
  await p.waitForSelector('.pdf-page canvas'); await p.waitForTimeout(800);
  await p.click('label[for="pdf-readall"]');
  await waitToast(p, /whole document is read/);
  const text = await convText(p);
  expect(text).toContain('Shelbyville');
  expect(text).not.toContain('Springfield');
});

test('a JPG can still be downloaded as a PDF', async ({ app: p }) => {
  await openFile(p, 'scan.jpg');
  await p.click('.menu-btn:has-text("File")');
  await expect(p.locator('#export-own')).toHaveText('JPG with your changes');
  const out = await download(p, '[data-action="export"][data-arg="pdf"]');
  expect(out.name).toBe('scan.pdf');
  expect(fs.readFileSync(out.file).subarray(0, 5).toString()).toBe('%PDF-');
});

test('a phone photo stored sideways opens upright', async ({ app: p }) => {
  await openFile(p, 'photo-sideways.jpg');
  const box = await p.locator('.pdf-page').first().boundingBox();
  expect(box.height).toBeGreaterThan(box.width);
  const out = await download(p, '.pdf-download');
  expect(await inspect(p, out.file, 'image/jpeg')).toEqual([1700, 2200]);
});

for (const [name, type] of [['scan.png', 'image/png'], ['scan.webp', 'image/webp']]) {
  test(`${name.split('.')[1].toUpperCase()} comes back as ${name.split('.')[1].toUpperCase()}`, async ({ app: p }) => {
    await openFile(p, name);
    const out = await download(p, '.pdf-download');
    expect(out.name).toBe(name);
    expect(await inspect(p, out.file, type)).toEqual([1700, 2200]);
  });
}

test('a two-page TIFF (fax-compressed, from a scanner program) reads, and saves as a two-page TIFF', async ({ app: p }) => {
  await openFile(p, 'scan-2pages.tif');
  await expect(p.locator('.pdf-page')).toHaveCount(2);
  await p.click('label[for="pdf-readall"]');
  await waitToast(p, /whole document is read/);
  const text = await convText(p);
  for (const w of ['Springfield', 'Phone']) expect(text).toContain(w);
  const out = await download(p, '.pdf-download');
  expect(out.name).toBe('scan-2pages.tif');
  // our own TIFF opens again, both pages, at the size it came in
  await p.setInputFiles('#file-open', out.file);
  await p.waitForSelector('.pdf-page canvas');
  await expect(p.locator('.pdf-page')).toHaveCount(2);
  expect(fs.statSync(out.file).size).toBeLessThan(1500000);
});
