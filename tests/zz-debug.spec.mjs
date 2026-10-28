// TEMPORARY: evidence for a WebKit-only failure. Removed before going live.
import { test, openFile } from './helpers.mjs';
test('debug: two pages drawn at the same time', async ({ app: p, browserName }) => {
  await openFile(p, 'letter.pdf'); // loads PDF.js
  const res = await p.evaluate(async () => {
    const r = await fetch('tests/files/scan-2pages.tif');
    const { bytes } = await NpImages.toPdf(new File([await r.blob()], 'x.tif', { type: 'image/tiff' }));
    const ink = async (page, scale) => {
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++;
      return Math.round(n / (scale * scale));
    };
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), wasmUrl: location.origin + '/vendor/pdfjs/wasm/' }).promise;
    const p1 = await doc.getPage(1); const p2 = await doc.getPage(2);
    const out = [];
    for (let k = 0; k < 4; k++) out.push((await Promise.all([ink(p1, 1.5), ink(p2, 4), ink(p1, 4), ink(p2, 1.5)])).join('/'));
    return out;
  });
  console.log(browserName, 'TOGETHER p1 1.5, p2 4, p1 4, p2 1.5:', JSON.stringify(res));
});

test('debug: whole-document read, watched', async ({ app: p, browserName }) => {
  test.setTimeout(200000);
  await openFile(p, 'multi-scan.pdf');
  await p.click('label[for="pdf-readall"]');
  const seen = [];
  for (let s = 0; s < 150; s += 10) {
    await p.waitForTimeout(10000);
    const st = await p.evaluate(() => ({ toast: document.getElementById('toast').textContent.slice(0, 90), status: document.getElementById('save-status').textContent, conv: [...document.querySelectorAll('.pdf-page')].map((pg) => pg.querySelectorAll('.pdf-conv').length), reading: document.querySelectorAll('.pdf-reading').length }));
    seen.push(s + 10 + 's ' + JSON.stringify(st));
    if (/whole document is read/.test(st.toast)) break;
  }
  console.log(browserName, 'WATCH', seen.join(' | '));
});
