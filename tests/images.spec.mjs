// Images open in the PDF editor, read and edit like a scan, and download as
// the same kind of image, the same size in pixels.
import fs from 'node:fs';
import { test, expect, openFile, waitToast, exportType } from './helpers.mjs';

// width, height and kind of a downloaded image, as the browser reads it
async function inspect(p, file, type) {
  const b64 = fs.readFileSync(file).toString('base64');
  return p.evaluate(async ([b64, type]) => {
    const b = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }));
    return [b.width, b.height];
  }, [b64, type]);
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
  await expect(p.locator('.pdf-download')).toHaveText('Save');
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

test('a JPG: Save as keeps it a JPG; Export makes it anything else', async ({ app: p }) => {
  await openFile(p, 'scan.jpg');
  // only one kind to save as, so no question: it is saved
  const [same] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => document.querySelector('[data-action="save-as"]').click())]);
  expect(same.suggestedFilename()).toBe('scan.jpg');
  await p.evaluate(() => document.querySelector('[data-action="export"]').click());
  await expect(p.locator('dialog[open] select option')).toHaveText(['PDF (.pdf)', 'Word document (.docx)', 'Plain text (.txt)', 'PNG image (.png)', 'WebP image (.webp)', 'TIFF image (.tif)', 'BMP image (.bmp)']);
  await p.keyboard.press('Escape');
  const dl = await exportType(p, 'pdf');
  expect(dl.suggestedFilename()).toBe('scan.pdf');
  expect(fs.readFileSync(await dl.path()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('a phone photo stored sideways opens upright', async ({ app: p }) => {
  await openFile(p, 'photo-sideways.jpg');
  const box = await p.locator('.pdf-page').first().boundingBox();
  expect(box.height).toBeGreaterThan(box.width);
  const out = await download(p, '.pdf-download');
  expect(await inspect(p, out.file, 'image/jpeg')).toEqual([1700, 2200]);
});

for (const [name, type] of [['scan.png', 'image/png'], ['scan.webp', 'image/webp'], ['scan.bmp', 'image/bmp']]) {
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

// Safari's engine mixed up the pictures of two pages drawn at the same time
// (page 1 came out with page 2's scan, and was read as page 2's words), so
// the app draws a document's pages one at a time. This draws several at once.
test('pages drawn at the same time keep their own pictures', async ({ app: p }) => {
  await openFile(p, 'letter.pdf'); // loads PDF.js
  const runs = await p.evaluate(async () => {
    const r = await fetch('tests/files/scan-2pages.tif');
    const { bytes } = await NpImages.toPdf(new File([await r.blob()], 'x.tif', { type: 'image/tiff' }));
    const view = await NpPdf.view(new Blob([bytes], { type: 'application/pdf' }));
    const [p1, p2] = [await view.page(0), await view.page(1)];
    const ink = async (page, scale) => {
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++;
      return n / (scale * scale);
    };
    const out = [];
    for (let k = 0; k < 3; k++) out.push(await Promise.all([ink(p1, 1.5), ink(p2, 4), ink(p1, 4), ink(p2, 1.5)]));
    view.destroy();
    return out;
  });
  // page 1 holds about twice the ink of page 2, at any size, every time
  for (const [a, b, c, d] of runs) {
    expect(a / b).toBeGreaterThan(1.6);
    expect(c / d).toBeGreaterThan(1.6);
  }
});
