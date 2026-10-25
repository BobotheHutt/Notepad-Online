/* Noteshack — images as documents.
   A JPG, PNG, WebP, TIFF or BMP opens in the PDF editor, each image a page, so
   every tool works on it: reading its text, straightening, editing. It is
   downloaded again as the same kind of file, at the same size in pixels,
   with the changes drawn in. A TIFF keeps all its pages; the others hold one
   picture each, so a document that has grown more pages comes out as a zip
   of them. */
(function () {
  'use strict';

  const FORMATS = {
    jpeg: { ext: 'jpg', mime: 'image/jpeg', name: 'JPG' },
    png: { ext: 'png', mime: 'image/png', name: 'PNG' },
    webp: { ext: 'webp', mime: 'image/webp', name: 'WebP' },
    tiff: { ext: 'tif', mime: 'image/tiff', name: 'TIFF' },
    bmp: { ext: 'bmp', mime: 'image/bmp', name: 'BMP' }
  };

  function formatOf(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg' || file.type === 'image/jpeg') return 'jpeg';
    if (ext === 'png' || file.type === 'image/png') return 'png';
    if (ext === 'webp' || file.type === 'image/webp') return 'webp';
    if (ext === 'tif' || ext === 'tiff' || file.type === 'image/tiff') return 'tiff';
    if (ext === 'bmp' || file.type === 'image/bmp') return 'bmp';
    return null;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the TIFF reader. Check your connection and try again.'));
      document.head.append(s);
    });
  }

  let utif = null;
  function loadUtif() {
    if (!utif) {
      utif = (async () => {
        await loadScript('vendor/utif/pako_inflate.min.js'); // UTIF uses it for Deflate-compressed TIFFs
        await loadScript('vendor/utif/UTIF.js');
      })();
      utif.catch(() => { utif = null; });
    }
    return utif;
  }

  /* ----- what the file says about itself: turn and resolution ----- */

  // A photo's turn (EXIF orientation, 1 = upright) and a JPEG's dots per inch.
  function jpegInfo(buf) {
    const d = new DataView(buf);
    const out = { orientation: 1, dpi: 0 };
    if (d.byteLength < 4 || d.getUint16(0) !== 0xffd8) return out;
    let p = 2;
    while (p + 4 <= d.byteLength) {
      const marker = d.getUint16(p);
      const len = d.getUint16(p + 2);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      if (marker === 0xffe0 && p + 16 <= d.byteLength && d.getUint32(p + 4) === 0x4a464946) { // JFIF
        const units = d.getUint8(p + 11);
        const x = d.getUint16(p + 12);
        if (units === 1) out.dpi = x;
        else if (units === 2) out.dpi = x * 2.54;
      }
      if (marker === 0xffe1 && p + 10 <= d.byteLength && d.getUint32(p + 4) === 0x45786966) { // Exif
        const t = p + 10;
        const le = d.getUint16(t) === 0x4949;
        const ifd = t + d.getUint32(t + 4, le);
        const n = ifd + 2 <= d.byteLength ? d.getUint16(ifd, le) : 0;
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > d.byteLength) break;
          if (d.getUint16(e, le) === 0x0112) out.orientation = d.getUint16(e + 8, le);
        }
      }
      p += 2 + len;
    }
    return out;
  }

  function pngDpi(buf) {
    const d = new DataView(buf);
    let p = 8;
    while (p + 12 <= d.byteLength) {
      const len = d.getUint32(p);
      const type = d.getUint32(p + 4);
      if (type === 0x70485973 && p + 17 <= d.byteLength && d.getUint8(p + 16) === 1) return d.getUint32(p + 8) * 0.0254; // pHYs, per metre
      if (type === 0x49444154) break; // image data: pHYs comes before it
      p += 12 + len;
    }
    return 0;
  }

  function bmpDpi(buf) {
    const d = new DataView(buf);
    return d.byteLength >= 46 && d.getUint16(0) === 0x424d && d.getUint32(14, true) >= 40 ? d.getInt32(38, true) * 0.0254 : 0;
  }

  // Dots per inch: the file's own if it is believable, else a guess that
  // makes the longer side about 11 inches, the size of a letter page.
  const dpiFor = (own, w, h) => (own >= 50 && own <= 2400 ? own : Math.min(600, Math.max(72, Math.max(w, h) / 11)));

  const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const toBytes = async (canvas, mime, q) => {
    const b = await new Promise((r) => canvas.toBlob(r, mime, q));
    return b ? { type: b.type, bytes: new Uint8Array(await b.arrayBuffer()) } : null;
  };

  /* ----- in: an image file as a PDF ----- */

  // { bytes: the PDF, origin: what to save it back as }
  async function toPdf(file) {
    const format = formatOf(file);
    if (!format) throw new Error('not an image Noteshack can open');
    const buf = await file.arrayBuffer();
    const pages = []; // { w, h, dpi, jpg | png }
    if (format === 'tiff') {
      await loadUtif();
      const ifds = UTIF.decode(buf).filter((f) => f.t256 && !(f.t254 && f.t254[0] & 1)); // pages, not thumbnails
      for (const ifd of ifds) {
        UTIF.decodeImage(buf, ifd);
        const c = canvasOf(ifd.width, ifd.height);
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(ifd).buffer), ifd.width, ifd.height), 0, 0);
        const own = ifd.t282 ? +ifd.t282[0] * (ifd.t296 && ifd.t296[0] === 3 ? 2.54 : 1) : 0;
        pages.push({ w: ifd.width, h: ifd.height, dpi: dpiFor(own, ifd.width, ifd.height), png: (await toBytes(c, 'image/png')).bytes });
      }
      if (!pages.length) throw new Error('the TIFF has no pages');
    } else {
      // createImageBitmap turns a photo upright by its EXIF orientation
      const bmp = await createImageBitmap(new Blob([buf], { type: FORMATS[format].mime }));
      const info = format === 'jpeg' ? jpegInfo(buf) : { orientation: 1, dpi: format === 'png' ? pngDpi(buf) : format === 'bmp' ? bmpDpi(buf) : 0 };
      const pg = { w: bmp.width, h: bmp.height, dpi: dpiFor(info.dpi, bmp.width, bmp.height) };
      // kept as it came where possible, so it is not compressed twice
      if (format === 'jpeg' && info.orientation <= 1) pg.jpg = new Uint8Array(buf);
      else if (format === 'png') pg.png = new Uint8Array(buf);
      else if (format === 'bmp') {
        // no loss: kept as PNG inside the PDF
        const c = canvasOf(bmp.width, bmp.height);
        c.getContext('2d').drawImage(bmp, 0, 0);
        pg.png = (await toBytes(c, 'image/png')).bytes;
      } else {
        const c = canvasOf(bmp.width, bmp.height);
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(bmp, 0, 0);
        pg.jpg = (await toBytes(c, 'image/jpeg', 0.95)).bytes;
      }
      bmp.close();
      pages.push(pg);
    }
    await NpPdf.libs();
    const pdf = await PDFLib.PDFDocument.create();
    for (const pg of pages) {
      const img = pg.jpg ? await pdf.embedJpg(pg.jpg) : await pdf.embedPng(pg.png);
      const w = (pg.w * 72) / pg.dpi;
      const h = (pg.h * 72) / pg.dpi;
      pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    return { bytes: (await pdf.save()).buffer, origin: { format, dpi: pages.map((p) => Math.round(p.dpi * 100) / 100) } };
  }

  /* ----- out: the edited PDF as the image it came from ----- */

  // Each page drawn at the image's own resolution, so the result is the
  // same size in pixels as what was opened.
  async function fromPdf(pdfBlob, origin, title, safeName) {
    const f = FORMATS[origin.format];
    const view = await NpPdf.view(pdfBlob);
    const tiff = origin.format === 'tiff' ? tiffWriter() : null;
    const files = [];
    let fellBack = false;
    try {
      for (let i = 0; i < view.count; i++) {
        const page = await view.page(i);
        const dpi = origin.dpi[Math.min(i, origin.dpi.length - 1)] || 150;
        const vp = page.getViewport({ scale: dpi / 72 });
        const c = canvasOf(Math.round(vp.width), Math.round(vp.height));
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        if (tiff) { await tiff.add(g.getImageData(0, 0, c.width, c.height), dpi); continue; }
        if (origin.format === 'bmp') { files.push({ bytes: bmpBytes(g.getImageData(0, 0, c.width, c.height), dpi), ext: 'bmp' }); continue; }
        let out = await toBytes(c, f.mime, 0.92);
        // a browser that cannot write WebP gives PNG instead
        if (!out || out.type !== f.mime) { out = await toBytes(c, 'image/png'); fellBack = true; }
        files.push({ bytes: out.bytes, ext: out.type === f.mime ? f.ext : 'png' });
      }
    } finally {
      view.destroy();
    }
    if (tiff) return { blob: tiff.finish(), filename: safeName(title, f.ext), fellBack };
    if (files.length === 1) return { blob: new Blob([files[0].bytes], { type: fellBack ? 'image/png' : f.mime }), filename: safeName(title, files[0].ext), fellBack };
    const base = safeName(title, 'x').slice(0, -2);
    return {
      blob: NpZip.write(files.map((x, i) => ({ name: base + ' - page ' + (i + 1) + '.' + x.ext, data: x.bytes })), 'application/zip'),
      filename: safeName(title, 'zip'),
      fellBack
    };
  }

  /* ----- a BMP writer: 24-bit, uncompressed, as BMPs nearly always are ----- */

  function bmpBytes(img, dpi) {
    const { width: w, height: h, data } = img;
    const row = (w * 3 + 3) & ~3; // rows are padded to four bytes
    const out = new Uint8Array(54 + row * h);
    const d = new DataView(out.buffer);
    d.setUint16(0, 0x424d); // "BM"
    d.setUint32(2, out.length, true);
    d.setUint32(10, 54, true);
    d.setUint32(14, 40, true);
    d.setInt32(18, w, true);
    d.setInt32(22, h, true); // positive: rows bottom to top
    d.setUint16(26, 1, true);
    d.setUint16(28, 24, true);
    d.setUint32(34, row * h, true);
    const ppm = Math.round(dpi / 0.0254);
    d.setInt32(38, ppm, true);
    d.setInt32(42, ppm, true);
    for (let y = 0; y < h; y++) {
      let o = 54 + (h - 1 - y) * row;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        out[o++] = data[i + 2]; out[o++] = data[i + 1]; out[o++] = data[i]; // blue, green, red
      }
    }
    return out;
  }

  /* ----- a TIFF writer: any number of pages, Deflate-compressed ----- */

  // Grey pages are stored grey (a third of the size); compression is the
  // browser's own (CompressionStream), which every TIFF reader accepts as
  // Adobe Deflate.
  function tiffWriter() {
    const parts = [];
    const head = new DataView(new ArrayBuffer(8));
    head.setUint16(0, 0x4949); // "II": little-endian
    head.setUint16(2, 42, true);
    parts.push(head);
    let off = 8;
    let next = { view: head, at: 4 }; // where the next page's address goes
    const push = (view) => { parts.push(view); off += view.byteLength; };

    async function add(img, dpi) {
      const { width: w, height: h, data } = img;
      let gray = true;
      for (let i = 0; i < data.length; i += 4) if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) { gray = false; break; }
      const spp = gray ? 1 : 3;
      const raw = new Uint8Array(w * h * spp);
      for (let i = 0, j = 0; i < data.length; i += 4) {
        raw[j++] = data[i];
        if (!gray) { raw[j++] = data[i + 1]; raw[j++] = data[i + 2]; }
      }
      const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
      const dataAt = off;
      push(new DataView(z.buffer));
      if (off & 1) push(new DataView(new ArrayBuffer(1)));
      let bpsAt = 0;
      if (!gray) {
        const b = new DataView(new ArrayBuffer(6));
        for (let k = 0; k < 3; k++) b.setUint16(k * 2, 8, true);
        bpsAt = off;
        push(b);
      }
      const res = new DataView(new ArrayBuffer(16));
      const d = Math.round(dpi * 100);
      res.setUint32(0, d, true); res.setUint32(4, 100, true);
      res.setUint32(8, d, true); res.setUint32(12, 100, true);
      const resAt = off;
      push(res);
      // tag, type (3 short, 4 long, 5 rational), count, value or address
      const entries = [
        [256, 4, 1, w], [257, 4, 1, h],
        [258, 3, spp, gray ? 8 : bpsAt],
        [259, 3, 1, 8], // Deflate
        [262, 3, 1, gray ? 1 : 2], // black is zero, or RGB
        [273, 4, 1, dataAt], [277, 3, 1, spp], [278, 4, 1, h], [279, 4, 1, z.length],
        [282, 5, 1, resAt], [283, 5, 1, resAt + 8], [296, 3, 1, 2] // inches
      ];
      const ifd = new DataView(new ArrayBuffer(2 + entries.length * 12 + 4));
      ifd.setUint16(0, entries.length, true);
      entries.forEach(([tag, type, count, v], i) => {
        const e = 2 + i * 12;
        ifd.setUint16(e, tag, true);
        ifd.setUint16(e + 2, type, true);
        ifd.setUint32(e + 4, count, true);
        if (type === 3 && count === 1) ifd.setUint16(e + 8, v, true);
        else ifd.setUint32(e + 8, v, true);
      });
      next.view.setUint32(next.at, off, true);
      next = { view: ifd, at: 2 + entries.length * 12 };
      push(ifd);
    }

    return { add, finish: () => new Blob(parts, { type: 'image/tiff' }) };
  }

  // what Save as needs to know of each kind: its file endings and type
  const kind = (format) => FORMATS[format] && {
    ext: FORMATS[format].ext, mime: FORMATS[format].mime, label: FORMATS[format].name + ' image',
    exts: format === 'jpeg' ? ['jpg', 'jpeg'] : format === 'tiff' ? ['tif', 'tiff'] : [FORMATS[format].ext]
  };

  window.NpImages = { formatOf, toPdf, fromPdf, kind, label: (origin) => FORMATS[origin.format].name };
})();
