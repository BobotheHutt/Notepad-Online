// TEMPORARY: evidence for a WebKit-only failure. Removed before going live.
import { test, expect, openFile } from './helpers.mjs';
test('debug: TIFF pages', async ({ app: p, browserName }) => {
  await openFile(p, 'scan-2pages.tif');
  await p.waitForTimeout(1500);
  const info = await p.evaluate(async () => {
    const out = {};
    out.canvases = [...document.querySelectorAll('.pdf-page canvas')].map((c) => { const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0, dark = 0; for (let i = 0; i < d.length; i += 4) { s = (s + d[i] * (i % 997)) % 1e9; if (d[i] < 100) dark++; } return c.width + 'x' + c.height + ' sum ' + s + ' dark ' + dark; });
    return out;
  });
  console.log(browserName, 'TIFF', JSON.stringify(info));
  // the PNGs made from each TIFF page, straight from the converter
  const conv = await p.evaluate(async () => {
    const r = await fetch('tests/files/scan-2pages.tif');
    const f = new File([await r.blob()], 'x.tif', { type: 'image/tiff' });
    const { bytes } = await NpImages.toPdf(f);
    const doc = await PDFLib.PDFDocument.load(bytes);
    return doc.getPages().map((pg) => pg.getSize().width + 'x' + pg.getSize().height) + ' bytes ' + bytes.byteLength;
  });
  console.log(browserName, 'converted', conv);
  expect(true).toBe(true);
});

test('debug: click to read', async ({ app: p, browserName }) => {
  const logs = [];
  p.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 150)));
  await openFile(p, 'multi-scan.pdf');
  await p.click('[data-pdf-tool="edit"]');
  const bb = await p.locator('.pdf-page').first().boundingBox();
  await p.mouse.click(bb.x + bb.width * 0.25, bb.y + bb.height * 0.16);
  await p.waitForSelector('.pdf-reading', { timeout: 10000 }).catch(() => logs.push('no reading note'));
  await p.waitForSelector('.pdf-reading', { state: 'detached', timeout: 180000 }).catch(() => logs.push('reading never ended'));
  await p.waitForTimeout(1500);
  const st = await p.evaluate(() => ({
    toast: document.getElementById('toast').textContent,
    conv: [...document.querySelectorAll('.pdf-page')].map((pg) => pg.querySelectorAll('.pdf-conv').length),
    editing: document.querySelectorAll('.pdf-textbox.editing').length,
    first: [...document.querySelectorAll('.pdf-conv')].slice(0, 3).map((n) => n.textContent)
  }));
  console.log(browserName, 'CLICK', JSON.stringify(st), JSON.stringify(logs.slice(-12)));
});
