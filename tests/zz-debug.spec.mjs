// TEMPORARY: evidence for a WebKit-only failure. Removed before going live.
import { test, openFile } from './helpers.mjs';
test('debug: PDF.js draws TIFF pages at two sizes', async ({ app: p, browserName }) => {
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
      return Math.round(n / (scale * scale)); // per square point, so sizes compare
    };
    const variants = { plain: {}, noOffscreen: { isOffscreenCanvasSupported: false }, noImageDecoder: { isImageDecoderSupported: false }, neither: { isOffscreenCanvasSupported: false, isImageDecoderSupported: false } };
    const out = {};
    for (const [name, opts] of Object.entries(variants)) {
      const doc = await pdfjsLib.getDocument(Object.assign({ data: new Uint8Array(bytes.slice(0)), wasmUrl: location.origin + '/vendor/pdfjs/wasm/' }, opts)).promise;
      const p1 = await doc.getPage(1); const p2 = await doc.getPage(2);
      out[name] = [await ink(p1, 1), await ink(p2, 1), await ink(p1, 4), await ink(p2, 4), await ink(p1, 1)].join(' / ');
      await doc.loadingTask.destroy();
    }
    return out;
  });
  console.log(browserName, 'DRAW p1,p2 small; p1,p2 large; p1 small again:', JSON.stringify(res));
});
