/* Notepad Online — PDF editor.
   PDF.js draws the pages; edits live as a list of items over them (text,
   boxes, ink, images, cover patches for replaced text) and pdf-lib writes them
   into the file only on download. The original bytes are never changed, so
   every edit can be undone or deleted.

   Coordinates: items are stored in PDF points on the page as displayed
   (after rotation), origin top-left, y down. toPdf/fromPdf convert to the
   page's own space when writing the file.

   NpPdf.init(api) once; NpPdf.open(record) / close(); NpPdf.download(record). */
(function () {
  'use strict';

  const VENDOR = 'vendor/';
  const $ = (s, r = document) => r.querySelector(s);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const DPR = () => Math.min(2, window.devicePixelRatio || 1);
  const PT_PX = 96 / 72;

  // How far below the top of a text box its first baseline sits, per font
  // family, at line-height 1.2 (from Arial / Times New Roman / Courier New metrics).
  const BASELINE = { sans: 0.947, serif: 0.938, mono: 0.867 };
  const LINE = 1.2;
  const CSS_FAMILY = { sans: 'Helvetica, Arial, sans-serif', serif: '"Times New Roman", Times, serif', mono: '"Courier New", Courier, monospace' };
  const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72, 96];

  const measureCtx = document.createElement('canvas').getContext('2d');
  // CSS font-family for an item: the matched font when it has one, with the
  // closest standard family behind it while that font is still loading.
  function familyCss(it) {
    return (it.font ? '"' + NpFonts.cssFamily(it.font) + '", ' : '') + CSS_FAMILY[it.family || 'sans'];
  }
  function fontCss(it, sizePx) {
    const w = it.font ? it.font.weight : it.bold ? 700 : 400;
    return (it.italic ? 'italic ' : '') + w + ' ' + sizePx + 'px ' + familyCss(it);
  }
  // width in points of text set in the item's standard font
  function textWidth(text, it) {
    measureCtx.font = fontCss(it, 100);
    return (measureCtx.measureText(text).width / 100) * it.size;
  }
  // where the ink starts after the pen position, and how wide the ink is (OCR
  // boxes are ink boxes, so new words are placed by their ink)
  function inkOf(text, it) {
    measureCtx.font = fontCss(it, 100);
    const m = measureCtx.measureText(text);
    const k = it.size / 100;
    return { lsb: -m.actualBoundingBoxLeft * k, w: (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) * k };
  }

  let api = null;
  let libs = null;

  const S = {
    rec: null,
    docs: [],             // PDF.js documents, one per source
    pageCache: new Map(), // "src:index" → PDF.js page
    info: new Map(),      // page uid → { w, h, W, H, x0, y0, rot, page, el, canvas, ... }
    fields: [],
    scale: 1,
    fit: true,
    tool: 'select',
    sel: null,
    editing: null,
    undo: [],
    redo: [],
    boldStroke: 0.16,
    observer: null,
    thumbObserver: null,
    style: Object.assign({ family: 'sans', size: 12, color: '#111111', bold: false, italic: false, ink: '#d93025', inkWidth: 2, box: '#d93025', boxWidth: 2, hl: '#fde047', white: '#ffffff' },
      (() => { try { return JSON.parse(localStorage.getItem('np.pdfStyle') || '{}'); } catch (e) { return {}; } })())
  };

  const el = (...a) => api.el(...a);

  /* ============================================================ libraries */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the PDF tools. Check your connection and try again.'));
      document.head.append(s);
    });
  }

  function loadLibs() {
    if (libs) return libs;
    libs = (async () => {
      await loadScript(VENDOR + 'pdfjs/pdf.min.js');
      if (/^https?:$/.test(location.protocol)) pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdfjs/pdf.worker.min.js';
      else await loadScript(VENDOR + 'pdfjs/pdf.worker.min.js'); // file:// cannot start a worker; PDF.js then runs in the page
      await loadScript(VENDOR + 'pdf-lib/pdf-lib.min.js');
    })();
    libs.catch(() => { libs = null; });
    return libs;
  }

  async function loadPdfJs(buffer) {
    return pdfjsLib.getDocument({
      data: new Uint8Array(buffer.slice(0)), // PDF.js takes ownership of what it is given
      isEvalSupported: false,                 // closes CVE-2024-4367 in this PDF.js version
      cMapUrl: VENDOR + 'pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: VENDOR + 'pdfjs/standard_fonts/'
    }).promise;
  }

  /* ============================================================ geometry */

  // displayed point → the page's own PDF space
  function toPdf(R, box, dx, dy) {
    const W = box.width;
    const H = box.height;
    let px;
    let py;
    if (R === 90) { px = dy; py = dx; }
    else if (R === 180) { px = W - dx; py = dy; }
    else if (R === 270) { px = W - dy; py = H - dx; }
    else { px = dx; py = H - dy; }
    return [px + box.x, py + box.y];
  }

  function fromPdf(R, box, px, py) {
    const W = box.width;
    const H = box.height;
    const x = px - box.x;
    const y = py - box.y;
    if (R === 90) return [y, x];
    if (R === 180) return [W - x, y];
    if (R === 270) return [H - y, W - x];
    return [x, H - y];
  }

  function rectToPdf(R, box, x, y, w, h) {
    const a = toPdf(R, box, x, y);
    const b = toPdf(R, box, x + w, y + h);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
  }

  /* ============================================================ state */

  function snap() {
    const r = S.rec;
    return JSON.stringify({ pages: r.pages, items: r.items, fields: r.fields });
  }

  function commit(before) {
    if (before === snap()) return;
    S.undo.push(before);
    if (S.undo.length > 150) S.undo.shift();
    S.redo = [];
    changed();
  }

  function changed() {
    S.rec.pageCount = S.rec.pages.length;
    api.changed();
    updateUndoButtons();
  }

  async function restore(json) {
    const prevPages = JSON.stringify(S.rec.pages);
    const st = JSON.parse(json);
    S.rec.pages = st.pages;
    S.rec.items = st.items;
    S.rec.fields = st.fields;
    S.sel = null;
    if (prevPages !== JSON.stringify(st.pages)) await build();
    else renderAllOverlays();
    renderStyleBar();
    changed();
  }

  async function undo() {
    if (S.editing) { finishEditing(); }
    if (!S.undo.length) return;
    const now = snap();
    S.redo.push(now);
    await restore(S.undo.pop());
  }

  async function redo() {
    if (!S.redo.length) return;
    S.undo.push(snap());
    await restore(S.redo.pop());
  }

  function updateUndoButtons() {
    const u = $('#pdf-toolbar [data-pdf="undo"]');
    const r = $('#pdf-toolbar [data-pdf="redo"]');
    if (u) u.disabled = !S.undo.length;
    if (r) r.disabled = !S.redo.length;
  }

  function saveStyle() {
    try { localStorage.setItem('np.pdfStyle', JSON.stringify(S.style)); } catch (e) { /* ignore */ }
  }

  const itemById = (id) => S.rec.items.find((i) => i.id === id);

  /* ============================================================ open / close */

  async function getPage(src, index) {
    const key = src + ':' + index;
    if (!S.pageCache.has(key)) S.pageCache.set(key, await S.docs[src].getPage(index + 1));
    return S.pageCache.get(key);
  }

  async function open(rec) {
    close();
    S.rec = rec;
    rec.items = rec.items || [];
    rec.fields = rec.fields || {};
    rec.pages = rec.pages || [];
    S.undo = [];
    S.redo = [];
    S.sel = null;
    S.fit = true;
    const stage = $('#pdf-pages');
    stage.replaceChildren(el('div', { class: 'pdf-msg' }, 'Opening PDF…'));
    try {
      await loadLibs();
      S.docs = [];
      for (const buf of rec.sources) S.docs.push(await loadPdfJs(buf));
    } catch (e) {
      const pw = e && e.name === 'PasswordException';
      stage.replaceChildren(el('div', { class: 'pdf-msg' }, pw
        ? 'This PDF is password-protected. Remove the password in another app, then open it again.'
        : 'This PDF could not be opened: ' + (e.message || e)));
      return;
    }
    if (S.rec !== rec) return;
    if (!rec.pages.length) {
      for (let i = 0; i < S.docs[0].numPages; i++) rec.pages.push({ uid: uid(), src: 0, index: i, rotate: 0 });
      rec.pageCount = rec.pages.length;
    }
    await loadForms();
    await build();
    setTool(S.tool === 'image' || S.tool === 'sign' ? 'select' : S.tool);
    updateUndoButtons();
    suggestOcr(rec);
    // matched fonts from earlier sessions: load them, then redraw with them
    const used = rec.items.filter((i) => i.font);
    if (used.length && typeof NpFonts !== 'undefined') {
      Promise.all(used.map((i) => NpFonts.load(i.font).catch(() => null))).then(() => { if (S.rec === rec) renderAllOverlays(); });
    }
  }

  function close() {
    if (S.observer) S.observer.disconnect();
    if (S.thumbObserver) S.thumbObserver.disconnect();
    for (const d of S.docs) { try { d.destroy(); } catch (e) { /* ignore */ } }
    S.docs = [];
    S.pageCache.clear();
    S.info.clear();
    S.fields = [];
    S.rec = null;
    S.editing = null;
    S.sel = null;
    const pages = $('#pdf-pages');
    if (pages) pages.replaceChildren();
    const thumbs = $('#pdf-thumb-list');
    if (thumbs) thumbs.replaceChildren();
  }

  async function loadForms() {
    S.fields = [];
    try {
      const doc = await PDFLib.PDFDocument.load(S.rec.sources[0], { updateMetadata: false });
      const form = doc.getForm();
      const pages = doc.getPages();
      const refPage = new Map();
      pages.forEach((p, i) => {
        const annots = p.node.Annots();
        if (annots) annots.asArray().forEach((ref) => refPage.set(String(ref), i));
      });
      for (const field of form.getFields()) {
        if (field.isReadOnly()) continue;
        let kind = null;
        if (field instanceof PDFLib.PDFTextField) kind = 'text';
        else if (field instanceof PDFLib.PDFCheckBox) kind = 'check';
        else if (field instanceof PDFLib.PDFDropdown || field instanceof PDFLib.PDFOptionList) kind = 'choice';
        else if (field instanceof PDFLib.PDFRadioGroup) kind = 'radio';
        if (!kind) continue;
        const name = field.getName();
        let initial = '';
        let options = [];
        if (kind === 'text') initial = field.getText() || '';
        if (kind === 'check') initial = field.isChecked();
        if (kind === 'choice') { options = field.getOptions(); initial = field.getSelected()[0] || ''; }
        if (kind === 'radio') { options = field.getOptions(); initial = field.getSelected() || ''; }
        const widgets = field.acroField.getWidgets();
        widgets.forEach((w, wi) => {
          const ref = doc.context.getObjectRef(w.dict);
          let pi = ref ? refPage.get(String(ref)) : undefined;
          if (pi === undefined && w.P()) pi = pages.findIndex((p) => p.ref === w.P());
          if (pi === undefined || pi < 0) return;
          const r = w.getRectangle();
          S.fields.push({
            name, kind, initial, options, pageIndex: pi, rect: r,
            multiline: kind === 'text' && field.isMultiline(),
            value: kind === 'radio' ? (options[wi] !== undefined && options.length === widgets.length ? options[wi] : (w.getOnValue() ? w.getOnValue().decodeText() : String(wi))) : null
          });
        });
      }
    } catch (e) {
      S.fields = []; // no form, or one pdf-lib cannot read: the pages still open
    }
  }

  /* ============================================================ layout */

  async function measure(entry) {
    if (entry.src < 0) {
      const rot = entry.rotate % 360;
      return { W: entry.w, H: entry.h, x0: 0, y0: 0, rot, w: rot % 180 ? entry.h : entry.w, h: rot % 180 ? entry.w : entry.h, page: null };
    }
    const page = await getPage(entry.src, entry.index);
    const [x0, y0, x1, y1] = page.view;
    const W = x1 - x0;
    const H = y1 - y0;
    const rot = (page.rotate + entry.rotate) % 360;
    return { W, H, x0, y0, rot, w: rot % 180 ? H : W, h: rot % 180 ? W : H, page };
  }

  async function build() {
    const rec = S.rec;
    if (!rec) return;
    if (S.observer) S.observer.disconnect();
    S.info.clear();
    const pagesEl = $('#pdf-pages');
    const frag = document.createDocumentFragment();
    for (const entry of rec.pages) {
      const info = await measure(entry);
      if (S.rec !== rec) return;
      info.entry = entry;
      info.el = el('div', { class: 'pdf-page', 'data-uid': entry.uid });
      info.canvas = el('canvas', { class: 'pdf-canvas' });
      info.layer = el('div', { class: 'pdf-layer' });
      info.el.append(info.canvas, info.layer);
      info.el.addEventListener('pointerdown', onPointerDown);
      S.info.set(entry.uid, info);
      frag.append(info.el);
    }
    pagesEl.replaceChildren(frag);
    if (S.fit) fitWidth(); else applyScale();
    S.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const info = S.info.get(e.target.dataset.uid);
        if (!info) continue;
        info.visible = e.isIntersecting;
        if (e.isIntersecting && info.renderedScale !== S.scale) renderPage(info);
      }
      updatePageStatus();
    }, { root: $('#pdf-scroller'), rootMargin: '600px 0px' });
    for (const info of S.info.values()) S.observer.observe(info.el);
    buildThumbs();
    renderAllOverlays();
    renderStyleBar();
    updatePageStatus();
  }

  function fitWidth() {
    const sc = $('#pdf-scroller');
    const max = Math.max(...Array.from(S.info.values()).map((i) => i.w), 1);
    const avail = Math.max(200, sc.clientWidth - 48);
    S.scale = clamp(avail / max, 0.25, PT_PX * 1.5);
    applyScale();
  }

  function applyScale() {
    for (const info of S.info.values()) {
      info.el.style.width = info.w * S.scale + 'px';
      info.el.style.height = info.h * S.scale + 'px';
      if (info.visible) renderPage(info);
    }
    renderAllOverlays();
    const z = $('#pdf-zoom');
    if (z) z.textContent = Math.round((S.scale / PT_PX) * 100) + '%';
    const sb = $('#sb-zoom');
    if (sb && document.body.classList.contains('pdf-mode')) sb.textContent = Math.round((S.scale / PT_PX) * 100) + '%';
  }

  function zoom(dir) {
    if (!S.rec) return;
    const sc = $('#pdf-scroller');
    const ratio = sc.scrollTop / Math.max(1, sc.scrollHeight);
    if (dir === 'reset') { S.fit = true; fitWidth(); }
    else {
      S.fit = false;
      S.scale = clamp(S.scale * (dir === 'in' ? 1.2 : 1 / 1.2), 0.25, 6);
      applyScale();
    }
    sc.scrollTop = ratio * sc.scrollHeight;
  }

  async function renderPage(info) {
    const scale = S.scale;
    info.renderedScale = scale;
    const c = info.canvas;
    const dpr = DPR();
    c.width = Math.max(1, Math.floor(info.w * scale * dpr));
    c.height = Math.max(1, Math.floor(info.h * scale * dpr));
    c.style.width = info.w * scale + 'px';
    c.style.height = info.h * scale + 'px';
    const ctx = c.getContext('2d');
    if (!info.page) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      return;
    }
    if (info.task) { try { info.task.cancel(); } catch (e) { /* ignore */ } }
    const viewport = info.page.getViewport({ scale: scale * dpr, rotation: info.rot });
    info.task = info.page.render({ canvasContext: ctx, viewport });
    let done = true;
    try { await info.task.promise; } catch (e) { done = false; /* cancelled by a newer render */ }
    info.task = null;
    if (done && S.rec && S.rec.items.some((i) => i.page === info.entry.uid && i.anchored && i.scan)) renderOverlay(info);
  }

  function updatePageStatus() {
    const n = S.rec ? S.rec.pages.length : 0;
    const cur = currentPage();
    const i = cur ? S.rec.pages.findIndex((p) => p.uid === cur.entry.uid) + 1 : 1;
    const t = 'Page ' + i + ' of ' + n;
    const sb = $('#sb-pdf');
    if (sb) sb.textContent = t;
    for (const li of document.querySelectorAll('.pdf-thumb')) li.classList.toggle('on', cur && li.dataset.uid === cur.entry.uid);
  }

  function currentPage() {
    const sc = $('#pdf-scroller');
    if (!sc) return null;
    const mid = sc.getBoundingClientRect().top + sc.clientHeight / 3;
    let best = null;
    let dist = Infinity;
    for (const info of S.info.values()) {
      const r = info.el.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < dist) { dist = d; best = info; }
    }
    return best;
  }

  /* ============================================================ overlays */

  function renderAllOverlays() {
    for (const info of S.info.values()) renderOverlay(info);
  }

  function px(v) { return v * S.scale + 'px'; }

  function renderOverlay(info) {
    if (S.editing && itemById(S.editing) && itemById(S.editing).page === info.entry.uid) return;
    const layer = info.layer;
    layer.replaceChildren();
    info.seq = (info.seq || 0) + 1;
    const mine = S.rec.items.filter((i) => i.page === info.entry.uid);
    // patches over replaced text go underneath everything else
    const coverDiv = (c, color, id) => el('div', { class: 'pdf-cover', 'data-id': id || null, style: 'left:' + px(c.x) + ';top:' + px(c.y) + ';width:' + px(c.w) + ';height:' + px(c.h) + ';background:' + color });
    for (const it of mine) {
      if (it.cover) layer.append(coverDiv(it.cover, it.cover.color));
      if (it.anchored) {
        if (S.editPrep === it.id) layer.append(coverDiv(phraseBox(it), it.bg, it.id));
        else {
          const lay = layoutEdit(it);
          for (const c of lay.covers) layer.append(coverDiv(c, it.bg, it.id));
          if (lay.shift) {
            // the moved words: a copy of the page's own pixels, slid along
            const sh = lay.shift;
            const band = { x: sh.x0, y: sh.y0, w: sh.x1 - sh.x0, h: sh.y1 - sh.y0 };
            layer.append(coverDiv(band, it.bg, it.id));
            const k = info.canvas.width / info.w;
            const cv = el('canvas', { class: 'pdf-cover pdf-shift', 'data-id': it.id, style: 'left:' + px(sh.x0 + sh.dx) + ';top:' + px(sh.y0) + ';width:' + px(band.w) + ';height:' + px(band.h) });
            cv.width = Math.max(1, Math.round(band.w * k));
            cv.height = Math.max(1, Math.round(band.h * k));
            try { cv.getContext('2d').drawImage(info.canvas, sh.x0 * k, sh.y0 * k, band.w * k, band.h * k, 0, 0, cv.width, cv.height); } catch (e) { /* page not drawn yet */ }
            layer.append(cv);
          }
        }
      }
    }
    let svg = null;
    for (const it of mine) {
      if (it.type === 'ink') {
        if (!svg) {
          svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('class', 'pdf-ink');
          svg.setAttribute('viewBox', '0 0 ' + info.w + ' ' + info.h);
          svg.setAttribute('preserveAspectRatio', 'none');
          layer.append(svg);
        }
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', inkPath(it.points));
        p.setAttribute('stroke', it.color);
        p.setAttribute('stroke-width', it.width);
        p.setAttribute('data-id', it.id);
        if (it.id === S.sel) p.setAttribute('class', 'sel');
        svg.append(p);
        continue;
      }
      layer.append(itemEl(it));
    }
    if (S.tool === 'edit') renderTextTargets(info);
    renderFields(info);
  }

  function inkPath(pts) {
    if (!pts.length) return '';
    let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    if (pts.length === 1) d += 'l0.01 0';
    for (let i = 1; i < pts.length; i++) d += 'L' + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1);
    return d;
  }

  function itemEl(it) {
    const sel = it.id === S.sel;
    if (it.type === 'text' && it.anchored && S.editPrep !== it.id) {
      // only the changed words are drawn; the rest of the line is the original
      const frag = document.createDocumentFragment();
      for (const r of layoutEdit(it).runs) {
        const d = el('div', {
          class: 'pdf-item pdf-textbox pdf-run' + (sel ? ' sel' : '') + (it.scan ? ' pdf-scan-text' : ''), 'data-id': it.id,
          style: 'left:' + px(r.x) + ';top:' + px(r.base - BASELINE[it.family] * it.size) + ';font-size:' + px(it.size) + ';font-family:' + familyCss(it).replace(/"/g, "'") +
            ';color:' + it.color + ';font-weight:' + (it.font ? it.font.weight : it.bold ? 700 : 400) + ';font-style:' + (it.italic ? 'italic' : 'normal') +
            (it.scan ? ';filter:blur(' + Math.max(0.2, 0.16 * S.scale).toFixed(2) + 'px)' : '') +
            (r.scaleX < 1 ? ';transform:scaleX(' + r.scaleX.toFixed(3) + ');transform-origin:0 0' : '')
        });
        d.textContent = r.text;
        frag.append(d);
      }
      return frag;
    }
    if (it.type === 'text') {
      const d = el('div', {
        class: 'pdf-item pdf-textbox' + (sel ? ' sel' : ''), 'data-id': it.id,
        style: 'left:' + px(it.x) + ';top:' + px(it.y) + ';font-size:' + px(it.size) + ';font-family:' + familyCss(it).replace(/"/g, "'") +
          ';color:' + it.color + ';font-weight:' + (it.font ? it.font.weight : it.bold ? 700 : 400) + ';font-style:' + (it.italic ? 'italic' : 'normal')
      });
      d.textContent = it.anchored ? it.text.replace(/\s+/g, ' ') : it.text;
      return d;
    }
    const st = 'left:' + px(it.x) + ';top:' + px(it.y) + ';width:' + px(it.w) + ';height:' + px(it.h) + ';';
    let d;
    if (it.type === 'image') {
      d = el('div', { class: 'pdf-item pdf-image' + (sel ? ' sel' : ''), 'data-id': it.id, style: st }, el('img', { src: it.src, alt: '', draggable: 'false' }));
    } else if (it.type === 'highlight') {
      d = el('div', { class: 'pdf-item pdf-hl' + (sel ? ' sel' : ''), 'data-id': it.id, style: st + 'background:' + it.color });
    } else if (it.type === 'whiteout') {
      d = el('div', { class: 'pdf-item pdf-white' + (sel ? ' sel' : ''), 'data-id': it.id, style: st + 'background:' + it.color });
    } else {
      d = el('div', { class: 'pdf-item pdf-box' + (sel ? ' sel' : ''), 'data-id': it.id, style: st + 'border:' + px(it.width) + ' solid ' + it.color });
    }
    if (sel) d.append(el('span', { class: 'pdf-handle', 'data-handle': '1' }));
    return d;
  }

  /* ----- clickable text on the page, for "Edit text" ----- */

  async function textItems(info) {
    if (info.text) return info.text;
    if (!info.page) return (info.text = []);
    const content = await info.page.getTextContent();
    const vp = info.page.getViewport({ scale: 1, rotation: info.rot });
    const out = [];
    content.items.forEach((item, i) => {
      if (!item.str || !item.str.trim()) return;
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01 || tx[0] < 0) return; // only text that reads left to right on screen
      const size = Math.hypot(tx[2], tx[3]);
      if (!size) return;
      const style = content.styles[item.fontName] || {};
      const ascent = style.ascent || 0.8;
      const fam = /mono|courier/i.test(style.fontFamily || '') ? 'mono' : /sans/i.test(style.fontFamily || '') ? 'sans' : /serif/i.test(style.fontFamily || '') ? 'serif' : 'sans';
      out.push({ key: info.entry.uid + ':' + i, str: item.str, x: tx[4], base: tx[5], size, top: tx[5] - ascent * size, w: item.width, fontName: item.fontName, family: fam });
    });
    info.nativeCount = out.length;
    // A scanned page has no text of its own: use what OCR read, if it has run.
    const ocr = S.rec.ocr && S.rec.ocr[info.entry.uid];
    if (!out.length && ocr && ocr.rot === info.rot) {
      ocr.lines.forEach((l, li) => ocrPhrases(l).forEach((ph, pi) => out.push({
        key: info.entry.uid + ':ocr' + li + '.' + pi, str: ph.map((w) => w.t).join(' '), x: ph[0].x0, base: l.base, size: l.size,
        top: Math.min(...ph.map((w) => w.y0)), w: ph[ph.length - 1].x1 - ph[0].x0, words: ph, scan: true, fontName: null, family: 'sans'
      })));
    }
    info.text = out;
    return out;
  }

  // Split an OCR line into the pieces a person would edit separately: table
  // borders that OCR reads as "|", and wide gaps between columns, end a piece.
  function ocrPhrases(l) {
    const raw = l.words && l.words.length ? l.words : [{ t: l.text, x: l.x, w: l.w }];
    const words = [];
    for (const w of raw) {
      let t = w.t;
      let x0 = w.x;
      let x1 = w.x + w.w;
      const y0 = w.y != null ? w.y : l.y;
      const y1 = w.y != null ? w.y + w.h : l.y + l.h;
      const per = (x1 - x0) / Math.max(1, t.length);
      if (/^[|¦\[\]]+$/.test(t)) { words.push({ sep: true }); continue; }
      let after = false;
      while (/^[|¦]/.test(t)) { t = t.slice(1); x0 += per; words.push({ sep: true }); }
      while (/[|¦]$/.test(t)) { t = t.slice(0, -1); x1 -= per; after = true; }
      if (t) words.push({ t, x0, x1, y0, y1, sw: w.sw });
      if (after) words.push({ sep: true });
    }
    const phrases = [];
    let cur = [];
    const gap = (l.h || l.size) * 1.3;
    for (const w of words) {
      if (w.sep || (cur.length && w.x0 - cur[cur.length - 1].x1 > gap)) { if (cur.length) phrases.push(cur); cur = []; if (w.sep) continue; }
      cur.push(w);
    }
    if (cur.length) phrases.push(cur);
    return phrases;
  }

  // Word positions inside a run of the PDF's own text, measured with the PDF's
  // own font when PDF.js has loaded it.
  function nativeWords(info, t) {
    let fam = CSS_FAMILY[t.family];
    try {
      const f = info.page.commonObjs.get(t.fontName);
      if (f && f.loadedName) fam = '"' + f.loadedName + '", ' + fam;
    } catch (e) { /* font not loaded */ }
    measureCtx.font = '100px ' + fam;
    const k = t.w / (measureCtx.measureText(t.str).width || 1);
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(t.str))) {
      const x0 = t.x + measureCtx.measureText(t.str.slice(0, m.index)).width * k;
      words.push({ t: m[0], x0, x1: x0 + measureCtx.measureText(m[0]).width * k, y0: t.top, y1: t.base + t.size * 0.22 });
    }
    return words;
  }

  // The smallest change between the original words and the edited text: the
  // words that differ are covered and redrawn, everything else is left as it
  // was. If the new words need more room than the old ones left, the rest of
  // the line is redrawn with them so nothing overlaps.
  function layoutEdit(it) {
    const orig = it.words || [];
    const neu = it.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    let p = 0;
    while (p < orig.length && p < neu.length && orig[p].t === neu[p]) p++;
    let s = 0;
    while (s < orig.length - p && s < neu.length - p && orig[orig.length - 1 - s].t === neu[neu.length - 1 - s]) s++;
    if (p === orig.length && p === neu.length) return { covers: [], runs: [] };
    const space = textWidth(' ', it);
    let end = orig.length - s;
    let mid = neu.slice(p, neu.length - s).join(' ');
    const x = p < orig.length ? orig[p].x0 : orig[orig.length - 1].x1 + space;
    const pad0 = Math.max(0.5, it.size * 0.04);
    const lastX1 = orig[orig.length - 1].x1;
    const limit0 = it.limit != null ? Math.max(it.limit, lastX1) : lastX1 + it.size * 0.2;
    // Lines read by OCR (scans, letters saved as shapes): the words after the
    // change are moved as they are, never retyped, so nothing OCR misread is
    // copied onto the page and they stay exactly the original letters.
    const gaps = orig.slice(1).map((w, k) => w.x0 - orig[k].x1).filter((g) => g > 0).sort((a, b) => a - b);
    const gap = gaps.length ? gaps[gaps.length >> 1] : space * 0.9;
    const ink = mid ? inkOf(mid, it) : { lsb: 0, w: 0 };
    if (it.scan && s > 0) {
      const midW = ink.w;
      const after = orig.slice(end);
      let dx = (mid ? x + midW + gap : x) - after[0].x0;
      if (dx < 0 && dx > -gap * 0.3) dx = 0;
      let scaleX = 1;
      let fits = true;
      if (lastX1 + dx > limit0 + 0.5) {
        // no room to move that far: move to the edge and narrow the new words
        dx = Math.max(0, limit0 - lastX1);
        const room = after[0].x0 + dx - gap - x;
        if (midW) scaleX = room / midW;
        fits = scaleX >= 0.8;
      }
      if (fits) {
        const gone = orig.slice(p, end);
        const covers = [];
        if (gone.length) {
          const y0 = Math.min(...gone.map((w) => w.y0));
          const y1 = Math.max(...gone.map((w) => w.y1));
          covers.push({ x: gone[0].x0 - pad0, y: y0 - pad0, w: gone[gone.length - 1].x1 - gone[0].x0 + pad0 * 2, h: y1 - y0 + pad0 * 2 });
        }
        const shift = dx ? {
          x0: after[0].x0 - pad0, x1: lastX1 + pad0, dx,
          y0: Math.min(...after.map((w) => w.y0)) - pad0, y1: Math.max(...after.map((w) => w.y1)) + pad0
        } : null;
        return { covers, shift, runs: mid ? [{ text: mid, x: x - ink.lsb * scaleX, base: it.base, scaleX: Math.min(1, scaleX) }] : [] };
      }
      // Even moved to the cell's edge there is no room: retype the rest of the
      // line, narrowed to fit (below), as the lesser evil to overlapping it.
    }
    if (s > 0 && mid && textWidth(mid, it) > orig[end].x0 - space - x + it.size * 0.15) {
      end = orig.length;
      mid = neu.slice(p).join(' ');
    }
    // a shorter replacement would leave a hole: move the rest of the line over
    if (end < orig.length && mid) {
      const removedW = orig[end - 1] ? orig[end - 1].x1 - x : 0;
      // with the original font matched, redrawing the rest of the line looks the
      // same as leaving it, so even a small gap is closed
      if (end > p && removedW - textWidth(mid, it) > space * (it.font ? 0.35 : 1.5)) { end = orig.length; mid = neu.slice(p).join(' '); }
    }
    const gone = orig.slice(p, end);
    const covers = [];
    if (gone.length) {
      const pad = Math.max(0.5, it.size * 0.04);
      const y0 = Math.min(...gone.map((w) => w.y0));
      const y1 = Math.max(...gone.map((w) => w.y1));
      covers.push({ x: gone[0].x0 - pad, y: y0 - pad, w: gone[gone.length - 1].x1 - gone[0].x0 + pad * 2, h: y1 - y0 + pad * 2 });
    }
    // Redrawn to the end of the line: keep it inside the line's own space (a
    // table cell, say) by narrowing the letters a little, never below 80%.
    let scaleX = 1;
    const limit = it.limit != null ? Math.max(it.limit, orig[orig.length - 1].x1) : orig[orig.length - 1].x1 + it.size * 0.2;
    if (mid && end === orig.length) {
      const room = limit - x;
      const need = textWidth(mid, it);
      if (need > room) scaleX = Math.max(0.8, room / need);
    }
    // OCR boxes are ink boxes: start the pen a side-bearing earlier
    const penX = it.scan && mid ? x - inkOf(mid, it).lsb * scaleX : x;
    return { covers, runs: mid ? [{ text: mid, x: penX, base: it.base, scaleX, overflow: mid && end === orig.length && textWidth(mid, it) * scaleX > limit - x + it.size * 0.1 }] : [] };
  }

  function phraseBox(it) {
    const w = it.words;
    const pad = Math.max(0.5, it.size * 0.04);
    const y0 = Math.min(...w.map((q) => q.y0));
    const y1 = Math.max(...w.map((q) => q.y1));
    return { x: w[0].x0 - pad, y: y0 - pad, w: w[w.length - 1].x1 - w[0].x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  async function renderTextTargets(info) {
    const seq = info.seq;
    const items = await textItems(info);
    // a newer render has replaced this layer while the text was loading
    if (S.tool !== 'edit' || !info.layer.isConnected || seq !== info.seq) return;
    const used = new Set(S.rec.items.filter((i) => i.origKey).map((i) => i.origKey));
    const frag = document.createDocumentFragment();
    for (const t of items) {
      if (used.has(t.key)) continue;
      frag.append(el('div', { class: 'pdf-target', 'data-key': t.key, title: 'Click to edit', 'aria-label': 'Edit: ' + t.str, style: 'left:' + px(t.x) + ';top:' + px(t.top) + ';width:' + px(Math.max(t.w, 2)) + ';height:' + px(t.base - t.top + t.size * 0.25) }));
    }
    info.layer.prepend(frag);
  }

  /* ----- form fields ----- */

  function renderFields(info) {
    if (info.entry.src !== 0 || !S.fields.length) return;
    const box = { x: info.x0, y: info.y0, width: info.W, height: info.H };
    for (const f of S.fields) {
      if (f.pageIndex !== info.entry.index) continue;
      const a = fromPdf(info.rot, box, f.rect.x, f.rect.y);
      const b = fromPdf(info.rot, box, f.rect.x + f.rect.width, f.rect.y + f.rect.height);
      const x = Math.min(a[0], b[0]);
      const y = Math.min(a[1], b[1]);
      const w = Math.abs(a[0] - b[0]);
      const h = Math.abs(a[1] - b[1]);
      // On a turned page the field turns with it: lay it out unturned around
      // the same center, then rotate it into place.
      const turned = info.rot % 180 !== 0;
      const fw = turned ? h : w;
      const fh = turned ? w : h;
      const style = 'left:' + px(x + w / 2 - fw / 2) + ';top:' + px(y + h / 2 - fh / 2) + ';width:' + px(fw) + ';height:' + px(fh) +
        ';font-size:' + px(clamp(fh * 0.62, 6, 14)) + (info.rot ? ';transform:rotate(' + info.rot + 'deg)' : '');
      const val = Object.prototype.hasOwnProperty.call(S.rec.fields, f.name) ? S.rec.fields[f.name] : f.initial;
      let input;
      if (f.kind === 'text') {
        input = f.multiline ? el('textarea', { class: 'pdf-field', style }) : el('input', { class: 'pdf-field', type: 'text', style });
        input.value = val;
      } else if (f.kind === 'check') {
        input = el('input', { class: 'pdf-field pdf-check', type: 'checkbox', style, checked: !!val });
      } else if (f.kind === 'radio') {
        input = el('input', { class: 'pdf-field pdf-check', type: 'radio', name: 'pdf-' + f.name, value: f.value, style, checked: val === f.value });
      } else {
        input = el('select', { class: 'pdf-field', style }, el('option', { value: '' }, ''), f.options.map((o) => el('option', { value: o, selected: o === val }, o)));
      }
      input.setAttribute('aria-label', f.name);
      input.addEventListener('change', () => {
        const before = snap();
        S.rec.fields[f.name] = f.kind === 'check' ? input.checked : f.kind === 'radio' ? f.value : input.value;
        commit(before);
      });
      info.layer.append(input);
    }
  }

  /* ============================================================ thumbnails */

  function buildThumbs() {
    const list = $('#pdf-thumb-list');
    if (S.thumbObserver) S.thumbObserver.disconnect();
    S.thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { renderThumb(e.target); S.thumbObserver.unobserve(e.target); }
    }, { root: $('#pdf-thumbs'), rootMargin: '300px 0px' });
    const n = S.rec.pages.length;
    list.replaceChildren(...S.rec.pages.map((entry, i) => {
      const info = S.info.get(entry.uid);
      const ratio = info.h / info.w;
      const btn = (icon, label, fn, disabled) => el('button', { type: 'button', class: 'icon-btn sm', 'data-icon': icon, title: label, 'aria-label': label + ', page ' + (i + 1), disabled: !!disabled, onclick: (ev) => { ev.stopPropagation(); fn(); } });
      const li = el('li', { class: 'pdf-thumb', 'data-uid': entry.uid },
        el('button', { type: 'button', class: 'pdf-thumb-open', 'aria-label': 'Go to page ' + (i + 1), onclick: () => scrollToPage(entry.uid) },
          el('canvas', { class: 'pdf-thumb-canvas', width: 112, height: Math.round(112 * ratio) }),
          el('span', { class: 'pdf-thumb-num' }, String(i + 1))),
        el('div', { class: 'pdf-thumb-actions' },
          btn('rotateL', 'Rotate left', () => rotatePage(entry.uid, -1)),
          btn('rotateR', 'Rotate right', () => rotatePage(entry.uid, 1)),
          btn('up', 'Move up', () => movePage(entry.uid, -1), i === 0),
          btn('down', 'Move down', () => movePage(entry.uid, 1), i === n - 1),
          btn('trash', 'Delete page', () => deletePage(entry.uid), n === 1)));
      S.thumbObserver.observe(li);
      return li;
    }));
    NpIcons.inject(list);
  }

  async function renderThumb(li) {
    const info = S.info.get(li.dataset.uid);
    if (!info) return;
    const c = li.querySelector('canvas');
    const ctx = c.getContext('2d');
    const scale = (c.width / info.w);
    if (!info.page) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); return; }
    const vp = info.page.getViewport({ scale, rotation: info.rot });
    try { await info.page.render({ canvasContext: ctx, viewport: vp }).promise; } catch (e) { /* ignore */ }
  }

  function scrollToPage(uidv) {
    const info = S.info.get(uidv);
    if (info) info.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.body.classList.remove('pdf-thumbs-open');
  }

  /* ============================================================ page operations */

  function rotateItems(uidv, dir) {
    const info = S.info.get(uidv);
    if (!info) return;
    let w = info.w;
    let h = info.h;
    const turns = (dir + 4) % 4;
    for (let t = 0; t < turns; t++) {
      // one quarter turn clockwise: (x, y) → (h − y, x) on a page h tall
      for (const it of S.rec.items) {
        if (it.page !== uidv) continue;
        if (it.type === 'ink') it.points = it.points.map(([x, y]) => [h - y, x]);
        else if (it.type === 'image' || it.type === 'text') {
          const iw = it.w || 0;
          const ih = it.h || 0;
          const cx = it.x + iw / 2;
          const cy = it.y + ih / 2;
          it.x = h - cy - iw / 2;
          it.y = cx - ih / 2;
        } else {
          const nx = h - (it.y + it.h);
          const ny = it.x;
          [it.x, it.y, it.w, it.h] = [nx, ny, it.h, it.w];
        }
        if (it.cover) {
          const c = it.cover;
          const nx = h - (c.y + c.h);
          [c.x, c.y, c.w, c.h] = [nx, c.x, c.h, c.w];
        }
      }
      [w, h] = [h, w];
    }
  }

  async function rotatePage(uidv, dir) {
    if (S.rec.items.some((i) => i.page === uidv && i.anchored)) {
      api.toast('This page has text edits tied to its original lines. Rotate it before editing text, or undo the edits first.', 6000);
      return;
    }
    const before = snap();
    const entry = S.rec.pages.find((p) => p.uid === uidv);
    if (!entry) return;
    measureTextItems();
    rotateItems(uidv, dir);
    if (S.rec.ocr) delete S.rec.ocr[uidv];
    entry.rotate = (entry.rotate + (dir > 0 ? 90 : 270)) % 360;
    commit(before);
    await build();
  }

  async function movePage(uidv, dir) {
    const i = S.rec.pages.findIndex((p) => p.uid === uidv);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= S.rec.pages.length) return;
    const before = snap();
    const pages = S.rec.pages;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    commit(before);
    await build();
    scrollToPage(uidv);
  }

  async function deletePage(uidv) {
    if (S.rec.pages.length <= 1) { api.toast('A PDF needs at least one page.'); return; }
    const before = snap();
    S.rec.pages = S.rec.pages.filter((p) => p.uid !== uidv);
    S.rec.items = S.rec.items.filter((i) => i.page !== uidv);
    commit(before);
    await build();
    api.toast('Page deleted. Undo (Ctrl+Z) brings it back.');
  }

  async function insertBlank() {
    const cur = currentPage();
    const before = snap();
    const W = cur ? cur.W : 612;
    const H = cur ? cur.H : 792;
    const entry = { uid: uid(), src: -1, w: W, h: H, rotate: cur ? cur.entry.rotate + (cur.page ? cur.page.rotate : 0) : 0 };
    entry.rotate %= 360;
    const at = cur ? S.rec.pages.indexOf(cur.entry) + 1 : S.rec.pages.length;
    S.rec.pages.splice(at, 0, entry);
    commit(before);
    await build();
    scrollToPage(entry.uid);
  }

  async function addPagesFrom(file) {
    const buf = await file.arrayBuffer();
    let doc;
    try { doc = await loadPdfJs(buf); } catch (e) { api.toast('“' + file.name + '” could not be opened as a PDF.'); return; }
    const before = snap();
    S.rec.sources.push(buf);
    S.docs.push(doc);
    const src = S.rec.sources.length - 1;
    const cur = currentPage();
    let at = cur ? S.rec.pages.indexOf(cur.entry) + 1 : S.rec.pages.length;
    const first = uid();
    for (let i = 0; i < doc.numPages; i++) S.rec.pages.splice(at++, 0, { uid: i === 0 ? first : uid(), src, index: i, rotate: 0 });
    commit(before);
    await build();
    scrollToPage(first);
    api.toast('Added ' + doc.numPages + ' page' + (doc.numPages === 1 ? '' : 's') + ' from “' + file.name + '”');
  }

  /* ============================================================ tools */

  function setTool(t) {
    if (S.editing) finishEditing();
    S.tool = t;
    for (const b of document.querySelectorAll('#pdf-toolbar [data-pdf-tool]')) {
      const on = b.dataset.pdfTool === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const stage = $('#pdf-stage');
    if (stage) stage.dataset.tool = t;
    if (t !== 'select') S.sel = null;
    renderAllOverlays();
    renderStyleBar();
    if (t === 'edit' && S.rec) api.toast('Click any text on the page to change it.', 2400);
  }

  function select(id) {
    if (S.sel === id) return;
    S.sel = id;
    renderAllOverlays();
    renderStyleBar();
  }

  function pointIn(e, info) {
    const r = info.el.getBoundingClientRect();
    return [(e.clientX - r.left) / S.scale, (e.clientY - r.top) / S.scale];
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const info = S.info.get(e.currentTarget.dataset.uid);
    if (!info) return;
    if (e.target.closest('.pdf-field')) return;
    if (S.editing) {
      if (e.target.closest('[contenteditable]')) return;
      finishEditing();
    }
    const [x, y] = pointIn(e, info);
    const itemNode = e.target.closest('[data-id]');
    const item = itemNode ? itemById(itemNode.getAttribute('data-id')) : null;
    const t = S.tool;

    if (t === 'select') {
      if (!item) { if (S.sel) select(null); return; }
      e.preventDefault();
      select(item.id);
      if (e.target.closest('[data-handle]')) startResize(e, info, item);
      else startMove(e, info, item);
      return;
    }
    if (t === 'text') {
      e.preventDefault();
      if (item && item.type === 'text') { startEditing(item.id); return; }
      const st = S.style;
      const it = { id: uid(), type: 'text', page: info.entry.uid, x, y: y - st.size * 0.6, size: st.size, family: st.family, color: st.color, bold: st.bold, italic: st.italic, text: '' };
      S.rec.items.push(it);
      S.editing = null;
      renderOverlay(info);
      startEditing(it.id, true);
      return;
    }
    if (t === 'edit') {
      const target = e.target.closest('.pdf-target');
      if (item && item.type === 'text') { e.preventDefault(); startEditing(item.id); return; }
      if (target) { e.preventDefault(); editOriginal(info, target.dataset.key); return; }
      if (info.text && !info.text.length) api.toast('This page is a scan, so its words are a picture. Click “Read text” first, then you can edit them.', 4500);
      return;
    }
    if (t === 'draw') { e.preventDefault(); startInk(e, info, x, y); return; }
    if (t === 'highlight' || t === 'whiteout' || t === 'box') { e.preventDefault(); startRect(e, info, x, y, t); }
  }

  function drag(e, onMove, onEnd) {
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      onEnd(ev);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  function startMove(e, info, item) {
    const before = snap();
    const [sx, sy] = pointIn(e, info);
    const orig = JSON.parse(JSON.stringify(item));
    let moved = false;
    drag(e, (ev) => {
      const [x, y] = pointIn(ev, info);
      const dx = x - sx;
      const dy = y - sy;
      if (item.anchored || (!moved && Math.hypot(dx, dy) * S.scale < 3)) return;
      moved = true;
      if (item.type === 'ink') item.points = orig.points.map(([px0, py0]) => [px0 + dx, py0 + dy]);
      else { item.x = orig.x + dx; item.y = orig.y + dy; }
      renderOverlay(info);
    }, () => {
      if (moved) { commit(before); S.lastTap = null; return; }
      // a second click on the same text box edits it
      const now = Date.now();
      if (item.type === 'text' && S.lastTap && S.lastTap.id === item.id && now - S.lastTap.t < 450) { S.lastTap = null; startEditing(item.id); return; }
      S.lastTap = { id: item.id, t: now };
    });
  }

  function startResize(e, info, item) {
    const before = snap();
    const [sx, sy] = pointIn(e, info);
    const ow = item.w;
    const oh = item.h;
    e.stopPropagation();
    drag(e, (ev) => {
      const [x, y] = pointIn(ev, info);
      let w = Math.max(4, ow + (x - sx));
      let h = Math.max(4, oh + (y - sy));
      if (item.type === 'image' && !ev.shiftKey) h = w * (oh / ow);
      item.w = w;
      item.h = h;
      renderOverlay(info);
    }, () => commit(before));
  }

  function startRect(e, info, x0, y0, kind) {
    const preview = el('div', { class: 'pdf-item pdf-preview pdf-' + (kind === 'highlight' ? 'hl' : kind === 'whiteout' ? 'white' : 'box') });
    const st = S.style;
    if (kind === 'highlight') preview.style.background = st.hl;
    if (kind === 'whiteout') preview.style.background = st.white;
    if (kind === 'box') preview.style.border = px(st.boxWidth) + ' solid ' + st.box;
    info.layer.append(preview);
    let rect = null;
    drag(e, (ev) => {
      const [x, y] = pointIn(ev, info);
      rect = { x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
      Object.assign(preview.style, { left: px(rect.x), top: px(rect.y), width: px(rect.w), height: px(rect.h) });
    }, () => {
      preview.remove();
      if (!rect || rect.w < 2 || rect.h < 2) return;
      const before = snap();
      const it = Object.assign({ id: uid(), type: kind, page: info.entry.uid }, rect);
      if (kind === 'highlight') it.color = st.hl;
      if (kind === 'whiteout') it.color = st.white;
      if (kind === 'box') { it.color = st.box; it.width = st.boxWidth; }
      S.rec.items.push(it);
      commit(before);
      renderOverlay(info);
    });
  }

  function startInk(e, info, x, y) {
    const st = S.style;
    const pts = [[x, y]];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pdf-ink pdf-ink-live');
    svg.setAttribute('viewBox', '0 0 ' + info.w + ' ' + info.h);
    svg.setAttribute('preserveAspectRatio', 'none');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke', st.ink);
    path.setAttribute('stroke-width', st.inkWidth);
    svg.append(path);
    info.layer.append(svg);
    path.setAttribute('d', inkPath(pts));
    drag(e, (ev) => {
      const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const c of events.length ? events : [ev]) pts.push(pointIn(c, info));
      path.setAttribute('d', inkPath(pts));
    }, () => {
      svg.remove();
      const before = snap();
      S.rec.items.push({ id: uid(), type: 'ink', page: info.entry.uid, points: simplify(pts, 0.35), color: st.ink, width: st.inkWidth });
      commit(before);
      renderOverlay(info);
    });
  }

  // Drop points closer than tol to the last kept one.
  function simplify(pts, tol) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const l = out[out.length - 1];
      if (Math.hypot(pts[i][0] - l[0], pts[i][1] - l[1]) >= tol || i === pts.length - 1) out.push([+pts[i][0].toFixed(2), +pts[i][1].toFixed(2)]);
    }
    return out;
  }

  /* ----- text editing ----- */

  function startEditing(id, isNew) {
    const it = itemById(id);
    if (!it) return;
    const info = S.info.get(it.page);
    S.sel = id;
    S.editing = null;
    S.editPrep = it.anchored ? id : null;
    renderOverlay(info);
    S.editPrep = null;
    S.editing = id;
    const node = info.layer.querySelector('.pdf-textbox[data-id="' + id + '"]');
    if (!node) return;
    node.classList.add('editing');
    try { node.contentEditable = 'plaintext-only'; } catch (e) { node.contentEditable = 'true'; }
    if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
    node.spellcheck = true;
    node.dataset.before = isNew ? '' : snap();
    node.dataset.isNew = isNew ? '1' : '';
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); node.blur(); }
      e.stopPropagation();
    });
    node.addEventListener('paste', (e) => {
      if (node.contentEditable === 'plaintext-only') return;
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData && e.clipboardData.getData('text/plain')) || '');
    });
    node.addEventListener('blur', () => finishEditing(), { once: true });
    node.focus();
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    renderStyleBar();
  }

  function finishEditing() {
    const id = S.editing;
    if (!id) return;
    S.editing = null;
    const it = itemById(id);
    const info = it && S.info.get(it.page);
    const node = info && info.layer.querySelector('.pdf-textbox[data-id="' + id + '"]');
    if (!it || !node) return;
    const before = node.dataset.isNew ? null : node.dataset.before;
    let text = node.innerText.replace(/\r/g, '').replace(/\n$/, '');
    if (it.anchored) text = text.replace(/\s+/g, ' ').trim();
    if (node.dataset.fresh && text === it.origText) {
      // clicked a run of the PDF's text but changed nothing: leave the page alone
      S.rec.items = S.rec.items.filter((i) => i.id !== id);
      S.sel = null;
      renderOverlay(info);
      renderStyleBar();
      return;
    }
    if (before === null) {
      // a brand-new box: the snapshot before it existed is the undo point
      const prev = JSON.parse(snap());
      prev.items = prev.items.filter((i) => i.id !== id);
      if (!text.trim()) {
        S.rec.items = S.rec.items.filter((i) => i.id !== id);
        S.sel = null;
      } else {
        it.text = text;
        measure1(it, node);
        commit(JSON.stringify(prev));
      }
    } else {
      if (!text.trim() && !it.cover && !it.anchored) {
        S.rec.items = S.rec.items.filter((i) => i.id !== id);
        S.sel = null;
      } else {
        it.text = text;
        measure1(it, node);
      }
      commit(before);
    }
    renderOverlay(info);
    renderStyleBar();
  }

  function measure1(it, node) {
    if (it.anchored) return;
    it.w = node.offsetWidth / S.scale;
    it.h = node.offsetHeight / S.scale;
  }

  function measureTextItems() {
    for (const info of S.info.values()) {
      for (const node of info.layer.querySelectorAll('.pdf-textbox:not(.pdf-run)')) {
        const it = itemById(node.getAttribute('data-id'));
        if (it) measure1(it, node);
      }
    }
  }

  // Edit a run of the PDF's own text (or a phrase OCR read on a scan). The
  // edit remembers the original words, so only the words you change are
  // erased and redrawn.
  async function editOriginal(info, key) {
    const t = (await textItems(info)).find((x) => x.key === key);
    if (!t) return;
    const before = snap();
    const words = t.words || nativeWords(info, t);
    if (!words.length) return;
    const ink = sampleInk(info, { x: words[0].x0, y: Math.min(...words.map((w) => w.y0)), w: words[words.length - 1].x1 - words[0].x0, h: Math.max(...words.map((w) => w.y1)) - Math.min(...words.map((w) => w.y0)) });
    const origText = words.map((w) => w.t).join(' ');
    const fam = t.family;
    let bold = false;
    let italic = false;
    let size = Math.round(t.size * 10) / 10;
    if (t.scan) {
      // Weight from how much ink the words hold, then the size that makes the
      // original words exactly as wide as they are on the scan.
      const sws = words.map((w) => w.sw).filter((v) => v > 0).sort((a, b) => a - b);
      bold = sws.length ? sws[sws.length >> 1] > S.boldStroke : ink.density > 0.3;
      const span = words[words.length - 1].x1 - words[0].x0;
      const fit = (b) => span / textWidth(origText, { family: fam, bold: b, italic: false, size: 1 });
      const s1 = fit(bold);
      if (s1 > t.size * 0.6 && s1 < t.size * 1.6) size = Math.round(s1 * 10) / 10;
    } else {
      try {
        const f = info.page.commonObjs.get(t.fontName);
        const name = (f && (f.name || f.loadedName)) || '';
        bold = !!(f && f.bold) || /bold|black|heavy|semibold|demi/i.test(name);
        italic = !!(f && f.italic) || /italic|oblique/i.test(name);
      } catch (e) { /* font not resolved yet */ }
    }
    // How far right the line may grow: up to the next text on the same line, a
    // table border (found while reading a scan), or the page margin.
    const lineEnd = words[words.length - 1].x1;
    const yTop = Math.min(...words.map((w) => w.y0));
    const yBot = Math.max(...words.map((w) => w.y1));
    let limit = info.w - Math.max(18, Math.min(words[0].x0, 72));
    for (const o of await textItems(info)) {
      if (o.key !== key && Math.abs(o.base - t.base) < t.size * 0.6 && o.x > lineEnd - 1) limit = Math.min(limit, o.x - t.size * 0.6);
    }
    const ocr = S.rec.ocr && S.rec.ocr[info.entry.uid];
    for (const r of (ocr && ocr.rules) || []) {
      if (r.x > lineEnd - 1 && r.y0 < yBot && r.y1 > yTop) limit = Math.min(limit, r.x - t.size * 0.35);
    }
    const it = {
      id: uid(), type: 'text', page: info.entry.uid, origKey: key, anchored: true, scan: !!t.scan, limit,
      words, origText, text: origText, x: words[0].x0, base: t.base, y: t.base - BASELINE[fam] * size,
      size, family: fam, color: ink.fg, bg: ink.bg, bold, italic
    };
    S.rec.items.push(it);
    renderOverlay(info);
    startEditing(it.id);
    const node = info.layer.querySelector('.pdf-textbox[data-id="' + it.id + '"]');
    if (node) { node.dataset.before = before; node.dataset.fresh = '1'; }
    matchFont(info, t, it, words);
  }

  /* ----- the original font ----- */

  // Find the font the words were set in and switch the edit to it: by the
  // name the PDF gives it, or for a scan (or an unnamed font) by comparing
  // the letters with common document fonts. Results are reused for the
  // session, so only the first edit in a given style waits for this.
  async function matchFont(info, t, it, words) {
    if (typeof NpFonts === 'undefined') return;
    let name = '';
    if (!t.scan && t.fontName) {
      try { const f = info.page.commonObjs.get(t.fontName); name = (f && f.name) || ''; } catch (e) { name = ''; }
    }
    const key = name ? 'name:' + name + (it.bold ? ':b' : '') : 'look:' + (it.bold ? 'b' : 'r') + ':' + Math.round(it.size);
    S.fontCache = S.fontCache || new Map();
    let ref = S.fontCache.get(key);
    try {
      if (ref === undefined) {
        if (name) ref = await NpFonts.fromName(name, { bold: it.bold, italic: it.italic });
        if (!ref) {
          api.status('Matching the font…', 'pending');
          // more words make a surer match: this phrase plus others on the page
          // set at the same size and weight
          const sw = (ws) => { const v = ws.map((w) => w.sw).filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
          const mine = sw(words);
          const pool = [words];
          for (const o of await textItems(info)) {
            if (!o.words || o.key === t.key || Math.abs(o.size - t.size) > t.size * 0.15) continue;
            const theirs = sw(o.words);
            if (mine != null && theirs != null && (theirs > S.boldStroke) !== (mine > S.boldStroke)) continue;
            pool.push(o.words);
          }
          const samples = [];
          for (const ws of pool) {
            if (samples.length >= 24) break;
            samples.push(...(await wordSamples(info, ws)).slice(0, 24 - samples.length));
          }
          ref = await NpFonts.identify(samples, { bold: it.bold });
          if (ref) S.lastMatch = ref.ranking;
          api.status('Saved', 'ok');
        }
        S.fontCache.set(key, ref || null);
      }
      if (!ref) return;
      await NpFonts.load(ref);
    } catch (e) {
      api.status('Saved', 'ok');
      if (!S.fontWarned) { S.fontWarned = true; api.toast('The matching font could not be downloaded, so the closest standard font is used.', 5000); }
      return;
    }
    if (!itemById(it.id)) return;
    it.font = { id: ref.id, weight: ref.weight, style: ref.style };
    it.bold = ref.weight >= 600;
    it.italic = ref.style === 'italic';
    const cat = NpFonts.CATALOG[ref.id] ? NpFonts.CATALOG[ref.id][1] : 'sans';
    it.family = cat === 'mono' ? 'mono' : cat === 'serif' ? 'serif' : 'sans';
    if (it.scan) {
      // with the real font, the size that makes the original words exactly as wide
      const span = words[words.length - 1].x1 - words[0].x0;
      const s1 = span / textWidth(it.origText, Object.assign({}, it, { size: 1 }));
      if (s1 > it.size * 0.7 && s1 < it.size * 1.4) it.size = Math.round(s1 * 10) / 10;
    }
    it.y = it.base - BASELINE[it.family] * it.size;
    const node = S.editing === it.id ? info.layer.querySelector('.pdf-textbox[data-id="' + it.id + '"]') : null;
    if (node) { applyTextStyle(node, it); node.style.top = px(it.y); } else renderOverlay(info);
    renderStyleBar();
    changed();
  }

  // The words, cut from a 300 dpi render of their part of the page.
  async function wordSamples(info, words) {
    const k = 300 / 72;
    const x0 = Math.min(...words.map((w) => w.x0)) - 2;
    const y0 = Math.min(...words.map((w) => w.y0)) - 2;
    const x1 = Math.max(...words.map((w) => w.x1)) + 2;
    const y1 = Math.max(...words.map((w) => w.y1)) + 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((x1 - x0) * k));
    c.height = Math.max(1, Math.ceil((y1 - y0) * k));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    if (info.page) await info.page.render({ canvasContext: g, viewport: info.page.getViewport({ scale: k, rotation: info.rot, offsetX: -x0 * k, offsetY: -y0 * k }) }).promise;
    return words.filter((w) => w.t.replace(/[^\p{L}\p{N}]/gu, '').length >= 2).slice(0, 8).map((w) => ({
      text: w.t, canvas: c,
      x: Math.max(0, Math.floor((w.x0 - x0) * k)), y: Math.max(0, Math.floor((w.y0 - y0) * k)),
      w: Math.min(c.width, Math.ceil((w.x1 - w.x0) * k)), h: Math.min(c.height, Math.ceil((w.y1 - w.y0) * k))
    })).filter((q) => q.w > 2 && q.h > 2 && q.x + q.w <= c.width && q.y + q.h <= c.height);
  }

  // Paper color, ink color and how much of the box is ink, from the rendered page.
  function sampleInk(info, r) {
    const out = { bg: '#ffffff', fg: '#000000', density: 0 };
    try {
      const c = info.canvas;
      const k = c.width / info.w;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const m = 2;
      const x = Math.max(0, Math.floor((r.x - m) * k));
      const y = Math.max(0, Math.floor((r.y - m) * k));
      const w = Math.min(c.width - x, Math.ceil((r.w + m * 2) * k));
      const h = Math.min(c.height - y, Math.ceil((r.h + m * 2) * k));
      if (w <= 2 || h <= 2) return out;
      const d = ctx.getImageData(x, y, w, h).data;
      const hex = (a) => '#' + a.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
      const counts = new Map();
      const add = (i) => { const key = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3); const v = counts.get(key) || [0, 0, 0, 0]; v[0]++; v[1] += d[i]; v[2] += d[i + 1]; v[3] += d[i + 2]; counts.set(key, v); };
      for (let xx = 0; xx < w; xx++) { add(xx * 4); add(((h - 1) * w + xx) * 4); }
      for (let yy = 0; yy < h; yy++) { add(yy * w * 4); add((yy * w + w - 1) * 4); }
      let best = null;
      for (const v of counts.values()) if (!best || v[0] > best[0]) best = v;
      const bg = best ? [best[1] / best[0], best[2] / best[0], best[3] / best[0]] : [255, 255, 255];
      out.bg = hex(bg);
      // ink: clearly darker than the paper; its color is the average of the
      // darkest eighth, the solid middle of the strokes rather than their soft edges
      const inner = { x0: Math.round(m * k), y0: Math.round(m * k), x1: w - Math.round(m * k), y1: h - Math.round(m * k) };
      const ink = [];
      let area = 0;
      for (let yy = inner.y0; yy < inner.y1; yy++) {
        for (let xx = inner.x0; xx < inner.x1; xx++) {
          const i = (yy * w + xx) * 4;
          area++;
          if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 120) ink.push(i);
        }
      }
      out.density = area ? ink.length / area : 0;
      if (ink.length) {
        ink.sort((p, q) => (d[p] + d[p + 1] + d[p + 2]) - (d[q] + d[q + 1] + d[q + 2]));
        const half = ink.slice(0, Math.max(1, Math.ceil(ink.length / 8)));
        const sum = [0, 0, 0];
        for (const i of half) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
        out.fg = hex(sum.map((v) => v / half.length));
      }
    } catch (e) { /* canvas not readable: defaults */ }
    return out;
  }

  /* ----- images and signatures ----- */

  async function toEmbeddable(src) {
    // pdf-lib reads PNG and JPEG; anything else is redrawn as PNG
    if (/^data:image\/(png|jpeg);/.test(src)) return src;
    const img = await loadImg(src);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  }

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That image could not be read.'));
      i.src = src;
    });
  }

  async function placeImage(src, opts = {}) {
    const info = currentPage();
    if (!info) return;
    src = await toEmbeddable(src);
    const img = await loadImg(src);
    const ratio = img.naturalHeight / img.naturalWidth;
    let w = Math.min(info.w * (opts.signature ? 0.3 : 0.5), img.naturalWidth * 0.75);
    let h = w * ratio;
    if (h > info.h * 0.6) { h = info.h * 0.6; w = h / ratio; }
    const sc = $('#pdf-scroller').getBoundingClientRect();
    const pr = info.el.getBoundingClientRect();
    const midY = clamp(((sc.top + sc.height / 2) - pr.top) / S.scale, h / 2, info.h - h / 2);
    const before = snap();
    const it = { id: uid(), type: 'image', page: info.entry.uid, x: (info.w - w) / 2, y: midY - h / 2, w, h, src };
    S.rec.items.push(it);
    setTool('select');
    S.sel = it.id;
    commit(before);
    renderOverlay(info);
    renderStyleBar();
  }

  function pickImage() {
    const input = $('#pdf-image-input');
    input.onchange = async () => {
      const f = input.files[0];
      input.value = '';
      if (!f) return;
      try {
        const src = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(fr.error); fr.readAsDataURL(f); });
        await placeImage(src);
      } catch (e) { api.toast(e.message || 'That image could not be added.'); }
    };
    input.click();
  }

  async function signature() {
    let saved = null;
    try { saved = localStorage.getItem('np.signature'); } catch (e) { /* ignore */ }
    const canvas = el('canvas', { class: 'sig-pad', width: 900, height: 300 });
    const ctx = canvas.getContext('2d');
    let drawn = false;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
    let last = null;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); last = pos(e); drawn = true; ctx.beginPath(); ctx.arc(last[0], last[1], 2.5, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill(); });
    canvas.addEventListener('pointermove', (e) => { if (!last) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last = p; });
    const end = () => { last = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    const clear = el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; } }, 'Clear');
    const body = el('div', { class: 'stack' },
      el('p', { class: 'dlg-text' }, 'Sign in the box with your mouse, finger or pen.'),
      canvas,
      el('div', { class: 'sig-row' }, clear,
        el('label', { class: 'toggle-row sig-remember' }, el('span', {}, 'Remember for next time'), el('input', { type: 'checkbox', class: 'switch', id: 'sig-remember', checked: true }))));
    const actions = [{ label: 'Cancel', value: '' }];
    if (saved) actions.push({ label: 'Use saved signature', value: 'saved' });
    actions.push({ label: 'Add signature', value: 'ok', primary: true });
    const v = await api.dialog({ title: 'Signature', body, actions, wide: true });
    if (v === 'saved' && saved) { await placeImage(saved, { signature: true }); return; }
    if (v !== 'ok') return;
    if (!drawn) { api.toast('Draw your signature first.'); return; }
    const png = trimCanvas(canvas);
    if (body.querySelector('#sig-remember').checked) { try { localStorage.setItem('np.signature', png); } catch (e) { /* ignore */ } }
    await placeImage(png, { signature: true });
  }

  function trimCanvas(c) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width;
    let y0 = c.height;
    let x1 = 0;
    let y1 = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = Math.max(1, x1 - x0 + 1);
    out.height = Math.max(1, y1 - y0 + 1);
    out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  /* ============================================================ OCR */

  // Tesseract reads scanned pages. Its lines are stored per page in display
  // points (rec.ocr[uid] = { rot, lines: [{ text, x, y, w, h, base, size }] })
  // and become Edit-text targets, plus an invisible, searchable text layer in
  // the downloaded file.

  let ocrWorker = null;

  async function getOcr(progress) {
    if (!/^https?:$/.test(location.protocol)) {
      throw new Error('Reading text needs the app opened from its web address (your GitHub Pages site), not from a file on this computer.');
    }
    if (ocrWorker) return ocrWorker;
    if (typeof Tesseract === 'undefined') await loadScript(VENDOR + 'tesseract/tesseract.min.js');
    const abs = (path) => new URL(VENDOR + 'tesseract/' + path, location.href).href;
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: abs('worker.min.js'),
      corePath: abs('tesseract-core-simd-lstm.wasm.js'),
      langPath: abs('').replace(/\/$/, ''),
      cacheMethod: 'none',
      logger: (m) => progress && progress(m)
    });
    return ocrWorker;
  }

  // A copy of the page with long straight lines (table borders, underlines,
  // boxes) painted out. Text pressed against a border is otherwise often
  // skipped by OCR, which reads the box as a picture.
  function withoutRules(c, px) {
    const W = c.width;
    const H = c.height;
    const dark = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) dark[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114 < 150 ? 1 : 0;
    const kill = new Uint8Array(W * H);
    const minH = Math.max(80, Math.round(W * 0.04));
    for (let y = 0; y < H; y++) {
      let start = -1;
      for (let x = 0; x <= W; x++) {
        const on = x < W && dark[y * W + x];
        if (on && start < 0) start = x;
        // the line and the soft edge either side of it
        if (!on && start >= 0) { if (x - start >= minH) for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let k = start; k < x; k++) kill[yy * W + k] = 1; start = -1; }
      }
    }
    const minV = Math.max(90, Math.round(H * 0.03));
    for (let x = 0; x < W; x++) {
      let start = -1;
      for (let y = 0; y <= H; y++) {
        const on = y < H && dark[y * W + x];
        if (on && start < 0) start = y;
        if (!on && start >= 0) { if (y - start >= minV) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) for (let k = start; k < y; k++) kill[k * W + xx] = 1; start = -1; }
      }
    }
    // vertical rules (cell borders), kept so edits know where a cell ends
    const rules = [];
    for (let x = 0; x < W; x++) {
      let start = -1;
      for (let y = 0; y <= H; y++) {
        const on = y < H && kill[y * W + x] && dark[y * W + x];
        if (on && start < 0) start = y;
        if (!on && start >= 0) {
          if (y - start >= minV) {
            const prev = rules[rules.length - 1];
            if (prev && x - prev.x1 <= 3 && Math.abs(prev.y0 - start) < 6) prev.x1 = x; else rules.push({ x0: x, x1: x, y0: start, y1: y });
          }
          start = -1;
        }
      }
    }
    const o = document.createElement('canvas');
    o.rules = rules;
    o.width = W;
    o.height = H;
    const og = o.getContext('2d');
    const img = og.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
      const k = i * 4;
      if (kill[i]) { d[k] = d[k + 1] = d[k + 2] = 255; }
      else { d[k] = px[k]; d[k + 1] = px[k + 1]; d[k + 2] = px[k + 2]; }
      d[k + 3] = 255;
    }
    og.putImageData(img, 0, 0);
    return o;
  }

  async function ocrPage(worker, info) {
    const k = Math.min(300 / 72, 3400 / Math.max(info.w, info.h));
    const c = document.createElement('canvas');
    c.width = Math.round(info.w * k);
    c.height = Math.round(info.h * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await info.page.render({ canvasContext: g, viewport: info.page.getViewport({ scale: k, rotation: info.rot }) }).promise;
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const clean = withoutRules(c, px);
    const { data } = await worker.recognize(clean);
    const rules = clean.rules.map((r) => ({ x: r.x0 / k, y0: r.y0 / k, y1: r.y1 / k }));
    // Stroke thickness relative to letter height (bold strokes are about half
    // again as thick), from the median run of ink along rows of the word.
    const stroke = (bb) => {
      const x0 = Math.max(0, bb.x0 | 0);
      const x1 = Math.min(c.width, bb.x1 | 0);
      const y0 = Math.max(0, bb.y0 | 0);
      const y1 = Math.min(c.height, bb.y1 | 0);
      const h = y1 - y0;
      if (h < 6 || x1 - x0 < 4) return null;
      let lo = 255;
      let hi = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * c.width + x) * 4;
        const v = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo < 60) return null;
      const thr = (lo + hi) / 2;
      const runs = [];
      for (let y = y0 + Math.round(h * 0.3); y < y1 - Math.round(h * 0.2); y++) {
        let run = 0;
        for (let x = x0; x < x1; x++) {
          const i = (y * c.width + x) * 4;
          if (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 < thr) run++;
          else if (run) { runs.push(run); run = 0; }
        }
        if (run) runs.push(run);
      }
      if (runs.length < 4) return null;
      runs.sort((a, b) => a - b);
      return Math.round((runs[runs.length >> 1] / h) * 1000) / 1000;
    };
    const lines = [];
    for (const l of data.lines || []) {
      const text = (l.text || '').replace(/\s+/g, ' ').trim();
      if (!text || l.confidence < 35) continue;
      const b = l.bbox;
      const bl = l.baseline && l.baseline.has_baseline !== false ? (l.baseline.y0 + l.baseline.y1) / 2 : b.y1;
      const lineH = (b.y1 - b.y0) / k;
      const base = Math.min(bl, b.y1) / k;
      const top = b.y0 / k;
      // top of the box to the baseline is about the cap height, ~0.7 em
      const size = clamp((base - top) / 0.7, lineH * 0.55, lineH * 1.6);
      const words = (l.words || []).filter((w) => w.text && w.text.trim()).map((w) => ({ t: w.text.trim(), x: w.bbox.x0 / k, w: (w.bbox.x1 - w.bbox.x0) / k, y: w.bbox.y0 / k, h: (w.bbox.y1 - w.bbox.y0) / k, sw: stroke(w.bbox) }));
      lines.push({ text, x: b.x0 / k, y: top, w: (b.x1 - b.x0) / k, h: lineH, base, size: Math.round(size * 10) / 10, words });
    }
    return { lines, rules };
  }

  async function nativeTextCount(info) {
    if (info.nativeCount === undefined) { info.text = null; await textItems(info); }
    return info.nativeCount;
  }

  async function runOcr(scope) {
    if (!S.rec || S.ocrBusy) return;
    const rec = S.rec;
    const cur = currentPage();
    const targets = [];
    for (const info of S.info.values()) {
      if (!info.page) continue;
      if (scope === 'current' && info !== cur) continue;
      if (scope !== 'current' && (await nativeTextCount(info)) >= 3) continue;
      targets.push(info);
    }
    if (!targets.length) {
      api.toast('This PDF already has real text, so Edit text works on it directly. To read one page anyway, use Pages → Read text on this page.', 6000);
      return;
    }
    S.ocrBusy = true;
    const btn = $('#pdf-toolbar [data-pdf="ocr"]');
    if (btn) btn.disabled = true;
    let found = 0;
    try {
      let n = 0;
      const worker = await getOcr((m) => {
        if (m.status === 'recognizing text') api.status('Reading text, page ' + n + ' of ' + targets.length + ' (' + Math.round((m.progress || 0) * 100) + '%)…', 'pending');
        else if (/load|initializ/.test(m.status || '')) api.status('Getting text recognition ready…', 'pending');
      });
      rec.ocr = rec.ocr || {};
      for (const info of targets) {
        n++;
        if (S.rec !== rec) return;
        api.status('Reading text, page ' + n + ' of ' + targets.length + '…', 'pending');
        const { lines, rules } = await ocrPage(worker, info);
        rec.ocr[info.entry.uid] = { rot: info.rot, lines, rules };
        if (lines.length) found++;
        info.text = null;
        info.nativeCount = undefined;
        renderOverlay(info);
      }
      const all = rec.pages.map((p) => (rec.ocr[p.uid] ? rec.ocr[p.uid].lines.map((l) => l.text).join('\n') : '')).join('\n');
      rec.text = ((rec.text || '') + '\n' + all).trim().slice(0, 200000);
      changed();
      if (found) {
        setTool('edit');
        api.toast('Read text on ' + found + ' page' + (found === 1 ? '' : 's') + '. Click any line to edit it. Downloads now include searchable, copyable text.', 6000);
      } else api.toast('No readable text was found. Very faint or handwritten pages may not work.', 6000);
    } catch (e) {
      api.toast(e.message || 'Text recognition failed.', 7000);
    } finally {
      S.ocrBusy = false;
      if (btn) btn.disabled = false;
      api.status('Saved', 'ok');
    }
  }

  async function copyPageText() {
    const info = currentPage();
    if (!info) return;
    const items = await textItems(info);
    if (!items.length) { api.toast('This page has no text to copy. If it is a scan, click “Read text” first.'); return; }
    const lines = [];
    let lastBase = null;
    for (const t of items.slice().sort((p, q) => (Math.abs(p.base - q.base) < p.size * 0.5 ? p.x - q.x : p.base - q.base))) {
      if (lastBase !== null && Math.abs(t.base - lastBase) < t.size * 0.5) lines[lines.length - 1] += ' ' + t.str;
      else lines.push(t.str);
      lastBase = t.base;
    }
    const text = lines.join('\n').replace(/ {2,}/g, ' ');
    try { await navigator.clipboard.writeText(text); api.toast('Copied the text of this page'); }
    catch (e) { api.toast('Your browser blocked copying. Select the text in the downloaded PDF instead.'); }
  }

  /* ============================================================ style bar */

  function renderStyleBar() {
    const bar = $('#pdf-style');
    if (!bar) return;
    const it = S.sel ? itemById(S.sel) : null;
    const kind = it ? it.type : S.tool;
    const st = S.style;
    const parts = [];
    const update = (fn) => {
      if (it) {
        const before = snap();
        fn(it);
        commit(before);
        const info = S.info.get(it.page);
        const wasEditing = S.editing === it.id;
        if (wasEditing) {
          const node = info.layer.querySelector('[data-id="' + it.id + '"]');
          if (node) { it.text = node.innerText.replace(/\n$/, ''); applyTextStyle(node, it); }
        } else renderOverlay(info);
      }
      saveStyle();
    };
    if (kind === 'text' || kind === 'edit') {
      const cur = it || st;
      const opts = [['sans', 'Sans (Helvetica)'], ['serif', 'Serif (Times)'], ['mono', 'Mono (Courier)']];
      if (it && it.font) opts.unshift(['matched', NpFonts.label(it.font) + ' (original)']);
      const fam = el('select', { class: 'tb-select', 'aria-label': 'Font', title: 'Font' },
        opts.map(([v, l]) => el('option', { value: v, selected: v === 'matched' ? true : !(it && it.font) && cur.family === v }, l)));
      fam.addEventListener('change', () => {
        if (fam.value === 'matched') return;
        st.family = fam.value;
        update((i) => { i.family = fam.value; delete i.font; });
      });
      const sizes = SIZES.includes(Math.round(cur.size)) ? SIZES : SIZES.concat([cur.size]).sort((a, b) => a - b);
      const size = el('select', { class: 'tb-select', 'aria-label': 'Size', title: 'Size' }, sizes.map((n) => el('option', { value: n, selected: Math.abs(n - cur.size) < 0.05 }, String(n))));
      size.addEventListener('change', () => { st.size = +size.value; update((i) => { i.size = +size.value; }); });
      const color = el('input', { type: 'color', class: 'pdf-color', value: cur.color || '#000000', 'aria-label': 'Text color', title: 'Text color' });
      color.addEventListener('change', () => { st.color = color.value; update((i) => { i.color = color.value; }); });
      const tog = (icon, label, prop) => {
        const b = el('button', { type: 'button', class: 'tb' + (cur[prop] ? ' on' : ''), 'data-icon': icon, title: label, 'aria-label': label, 'aria-pressed': cur[prop] ? 'true' : 'false' });
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => { const v = !(it ? it[prop] : st[prop]); st[prop] = v; b.classList.toggle('on', v); update((i) => { i[prop] = v; }); });
        return b;
      };
      parts.push(fam, size, color, tog('bold', 'Bold', 'bold'), tog('italic', 'Italic', 'italic'));
    } else if (kind === 'ink' || kind === 'draw' || kind === 'box') {
      const isInk = kind === 'ink' || kind === 'draw';
      const cur = it ? it.color : (isInk ? st.ink : st.box);
      const wcur = it ? it.width : (isInk ? st.inkWidth : st.boxWidth);
      const color = el('input', { type: 'color', class: 'pdf-color', value: cur, 'aria-label': 'Color', title: 'Color' });
      color.addEventListener('change', () => { if (isInk) st.ink = color.value; else st.box = color.value; update((i) => { i.color = color.value; }); });
      const width = el('select', { class: 'tb-select', 'aria-label': 'Line width', title: 'Line width' }, [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12].map((n) => el('option', { value: n, selected: n === wcur }, n + ' pt')));
      width.addEventListener('change', () => { if (isInk) st.inkWidth = +width.value; else st.boxWidth = +width.value; update((i) => { i.width = +width.value; }); });
      parts.push(color, width);
    } else if (kind === 'highlight' || kind === 'whiteout') {
      const prop = kind === 'highlight' ? 'hl' : 'white';
      const color = el('input', { type: 'color', class: 'pdf-color', value: it ? it.color : st[prop], 'aria-label': 'Color', title: 'Color' });
      color.addEventListener('change', () => { st[prop] = color.value; update((i) => { i.color = color.value; }); });
      parts.push(color);
    }
    if (it) {
      if (it.cover) {
        const restore = el('button', { type: 'button', class: 'btn btn-sm', title: 'Remove this change and show the original text again' }, 'Restore original');
        restore.addEventListener('click', () => deleteSelected());
        parts.push(restore);
      }
      const del = el('button', { type: 'button', class: 'tb', 'data-icon': 'trash', title: 'Delete (Del)', 'aria-label': 'Delete' });
      del.addEventListener('mousedown', (e) => e.preventDefault());
      del.addEventListener('click', () => deleteSelected());
      parts.push(del);
    }
    bar.replaceChildren(...parts);
    bar.hidden = !parts.length;
    NpIcons.inject(bar);
  }

  function applyTextStyle(node, it) {
    node.style.fontSize = px(it.size);
    node.style.fontFamily = familyCss(it);
    node.style.color = it.color;
    node.style.fontWeight = it.font ? it.font.weight : it.bold ? 700 : 400;
    node.style.fontStyle = it.italic ? 'italic' : 'normal';
  }

  function deleteSelected() {
    const it = S.sel && itemById(S.sel);
    if (!it) return;
    const before = node0Before(it) || snap();
    S.editing = null;
    S.rec.items = S.rec.items.filter((i) => i.id !== it.id);
    S.sel = null;
    commit(before);
    renderOverlay(S.info.get(it.page));
    renderStyleBar();
  }

  function node0Before(it) {
    const info = S.info.get(it.page);
    const node = info && info.layer.querySelector('[data-id="' + it.id + '"]');
    if (node && node.dataset.before) return node.dataset.before;
    return null;
  }

  /* ============================================================ keyboard */

  function onKey(e) {
    if (!S.rec || !document.body.classList.contains('pdf-mode')) return false;
    if (document.querySelector('dialog[open]')) return false;
    const inField = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel && !inField) { e.preventDefault(); deleteSelected(); return true; }
    if (e.key === 'Escape' && !inField) {
      if (S.sel) { select(null); return true; }
      if (S.tool !== 'select') { setTool('select'); return true; }
    }
    if (!inField && S.sel && e.key.startsWith('Arrow')) {
      const it = itemById(S.sel);
      const step = (e.shiftKey ? 10 : 1);
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const before = snap();
      if (it.type === 'ink') it.points = it.points.map(([x, y]) => [x + dx, y + dy]);
      else { it.x += dx; it.y += dy; }
      commit(before);
      renderOverlay(S.info.get(it.page));
      e.preventDefault();
      return true;
    }
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (mod && !inField) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return true; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return true; }
    }
    if (!inField && !mod && !e.altKey) {
      const keys = { v: 'select', e: 'edit', t: 'text', h: 'highlight', w: 'whiteout', d: 'draw', b: 'box' };
      if (keys[e.key]) { setTool(keys[e.key]); return true; }
    }
    return false;
  }

  /* ============================================================ erasing text */

  // Covering text only hides it: the words stay in the file and can be
  // copied out. On download, every glyph whose center falls inside a cover
  // (edited text, white-out) is removed from the page's content stream, and
  // the glyphs after it are shifted back into their original places with TJ
  // spacing, so the rest of the line does not move.

  const WINANSI_HIGH = [0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0,
    0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178];
  const STD14 = ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique',
    'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats'];

  /* ----- content stream tokenizer ----- */

  const isWs = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

  // → [{ op, args, start, end }] with byte offsets into the stream
  function parseContent(b) {
    const ops = [];
    const stack = [[]];
    let i = 0;
    let opStart = -1;
    const n = b.length;
    const push = (v, at) => { if (stack.length === 1 && opStart < 0) opStart = at; stack[stack.length - 1].push(v); };
    while (i < n) {
      const c = b[i];
      if (isWs(c)) { i++; continue; }
      if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
      const at = i;
      if (c === 40) { // (literal string)
        const out = [];
        let depth = 1;
        i++;
        while (i < n && depth) {
          let ch = b[i++];
          if (ch === 92) {
            const e = b[i++];
            if (e === 110) out.push(10); else if (e === 114) out.push(13); else if (e === 116) out.push(9);
            else if (e === 98) out.push(8); else if (e === 102) out.push(12);
            else if (e === 13) { if (b[i] === 10) i++; }
            else if (e === 10) { /* line continuation */ }
            else if (e >= 48 && e <= 55) {
              let v = e - 48;
              for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48);
              out.push(v & 255);
            } else out.push(e);
            continue;
          }
          if (ch === 40) depth++;
          if (ch === 41 && --depth === 0) break;
          out.push(ch);
        }
        push({ t: 'str', v: Uint8Array.from(out) }, at);
        continue;
      }
      if (c === 60 && b[i + 1] === 60) { stack.push([]); if (stack.length === 2 && opStart < 0) opStart = at; i += 2; continue; }
      if (c === 62 && b[i + 1] === 62) { const d = stack.pop(); i += 2; push({ t: 'dict', v: d }, at); continue; }
      if (c === 60) {
        let j = i + 1;
        let hex = '';
        while (j < n && b[j] !== 62) { if (!isWs(b[j])) hex += String.fromCharCode(b[j]); j++; }
        if (hex.length % 2) hex += '0';
        const out = new Uint8Array(hex.length / 2);
        for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16) || 0;
        i = j + 1;
        push({ t: 'str', v: out }, at);
        continue;
      }
      if (c === 91) { stack.push([]); if (stack.length === 2 && opStart < 0) opStart = at; i++; continue; }
      if (c === 93) { const a = stack.pop(); i++; push({ t: 'arr', v: a }, at); continue; }
      if (c === 47) {
        let j = i + 1;
        while (j < n && !isWs(b[j]) && !isDelim(b[j])) j++;
        push({ t: 'name', v: String.fromCharCode.apply(null, b.subarray(i + 1, j)) }, at);
        i = j;
        continue;
      }
      let j = i;
      while (j < n && !isWs(b[j]) && !isDelim(b[j])) j++;
      if (j === i) { i++; continue; } // stray delimiter
      const word = String.fromCharCode.apply(null, b.subarray(i, j));
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push({ t: 'num', v: parseFloat(word) }, at); continue; }
      if (word === 'true' || word === 'false' || word === 'null') { push({ t: 'kw', v: word }, at); continue; }
      if (stack.length > 1) { push({ t: 'kw', v: word }, at); continue; }
      // an operator ends the current operation
      if (word === 'ID') {
        // inline image data runs to the next whitespace-delimited EI
        let k = i + 1;
        while (k < n - 1 && !(isWs(b[k - 1]) && b[k] === 69 && b[k + 1] === 73 && (k + 2 >= n || isWs(b[k + 2]) || isDelim(b[k + 2])))) k++;
        i = Math.min(n, k + 2);
        const bi = ops.length && ops[ops.length - 1].op === 'BI' ? ops.pop() : null;
        ops.push({ op: 'INLINE', args: [], start: bi ? bi.start : (opStart < 0 ? at : opStart), end: i });
        stack[0] = [];
        opStart = -1;
        continue;
      }
      ops.push({ op: word, args: stack[0], start: opStart < 0 ? at : opStart, end: i });
      stack[0] = [];
      opStart = -1;
    }
    return ops;
  }

  /* ----- fonts: code lengths and widths ----- */

  function num(o) { return o && typeof o.asNumber === 'function' ? o.asNumber() : 0; }

  function fontMetrics(dict) {
    const L = PDFLib;
    const N = (k) => L.PDFName.of(k);
    const subtype = dict.lookup(N('Subtype'));
    const sub = subtype ? subtype.decodeText() : '';
    if (sub === 'Type0') {
      const descs = dict.lookup(N('DescendantFonts'));
      const desc = descs && descs.lookup(0);
      const dw = desc && desc.lookup(N('DW')) ? num(desc.lookup(N('DW'))) : 1000;
      const widths = new Map();
      const W = desc && desc.lookup(N('W'));
      if (W) {
        const a = W.asArray().map((x, k) => W.lookup(k));
        for (let k = 0; k < a.length;) {
          const first = num(a[k]);
          const next = a[k + 1];
          if (next && typeof next.asArray === 'function') {
            next.asArray().forEach((_, m) => widths.set(first + m, num(next.lookup(m))));
            k += 2;
          } else {
            const last = num(a[k + 1]);
            const w = num(a[k + 2]);
            for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, w);
            k += 3;
          }
        }
      }
      return { bytes: 2, width: (code) => (widths.has(code) ? widths.get(code) : dw), space: -1 };
    }
    const first = dict.lookup(N('FirstChar')) ? num(dict.lookup(N('FirstChar'))) : 0;
    const Warr = dict.lookup(N('Widths'));
    let scale = 1;
    if (sub === 'Type3') {
      const fm = dict.lookup(N('FontMatrix'));
      scale = fm ? num(fm.lookup(0)) * 1000 : 1;
    }
    let std = null;
    if (!Warr) {
      const base = dict.lookup(N('BaseFont'));
      let name = base ? base.decodeText().replace(/^[A-Z]{6}\+/, '') : 'Helvetica';
      if (!STD14.includes(name)) {
        const bold = /bold|black|heavy/i.test(name);
        const ital = /italic|oblique/i.test(name);
        if (/times|serif|roman|georgia|garamond/i.test(name)) name = 'Times-' + (bold && ital ? 'BoldItalic' : bold ? 'Bold' : ital ? 'Italic' : 'Roman');
        else if (/courier|mono/i.test(name)) name = 'Courier' + (bold && ital ? '-BoldOblique' : bold ? '-Bold' : ital ? '-Oblique' : '');
        else name = 'Helvetica' + (bold && ital ? '-BoldOblique' : bold ? '-Bold' : ital ? '-Oblique' : '');
      }
      try { std = L.StandardFontEmbedder.for(name); } catch (e) { std = null; }
    }
    const cache = new Map();
    return {
      bytes: 1,
      space: 32,
      width: (code) => {
        if (Warr) {
          const k = code - first;
          return k >= 0 && k < Warr.size() ? num(Warr.lookup(k)) * scale : 0;
        }
        if (cache.has(code)) return cache.get(code);
        let w = 500;
        if (std) {
          const u = code >= 128 && code < 160 ? WINANSI_HIGH[code - 128] : code;
          try { if (u) w = std.widthOfTextAtSize(String.fromCharCode(u), 1000); } catch (e) { w = 500; }
        }
        cache.set(code, w);
        return w;
      }
    };
  }

  /* ----- walking a content stream ----- */

  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const fmtNum = (v) => String(Math.round(v * 1000) / 1000);
  const hexOf = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');

  function contentBytes(obj) {
    const L = PDFLib;
    if (obj instanceof L.PDFRawStream) return L.decodePDFRawStream(obj).decode();
    if (typeof obj.getUnencodedContents === 'function') return obj.getUnencodedContents();
    if (typeof obj.getContents === 'function') return obj.getContents();
    return new Uint8Array(0);
  }

  // Remove glyphs inside regions from one content stream. Returns new bytes or
  // null when nothing was removed; `count` totals removed glyphs.
  function eraseIn(bytes, resources, ctm0, regions, ctx, count, depth) {
    const L = PDFLib;
    const N = (k) => L.PDFName.of(k);
    const ops = parseContent(bytes);
    const fonts = resources && resources.lookup(N('Font'));
    const xobjs = resources && resources.lookup(N('XObject'));
    const fontCache = new Map();
    const getFont = (name) => {
      if (fontCache.has(name)) return fontCache.get(name);
      let f = null;
      try { const d = fonts && fonts.lookup(N(name)); if (d) f = fontMetrics(d); } catch (e) { f = null; }
      fontCache.set(name, f);
      return f;
    };
    let gs = { ctm: ctm0, font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
    const stack = [];
    let tm = [1, 0, 0, 1, 0, 0];
    let tlm = [1, 0, 0, 1, 0, 0];
    const edits = [];
    // Text that was turned into drawn shapes (Microsoft Print to PDF does this
    // to every letter): a filled shape lying wholly inside a cover is removed.
    // Larger shapes that only cross it, like table borders, stay.
    let pathStart = -1;
    let pts = [];
    const within = (b) => regions.some((r) => b.x0 >= r.x - 1 && b.x1 <= r.x + r.width + 1 && b.y0 >= r.y - 1 && b.y1 <= r.y + r.height + 1);
    const inside = (x, y) => regions.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);

    // Lay out one string; returns the TJ parts with erased glyphs replaced by spacing.
    const show = (str, parts) => {
      const f = gs.font;
      const per = f ? f.bytes : 1;
      let removedHere = 0;
      let keep = [];
      const flushKeep = () => { if (keep.length) { parts.push({ s: Uint8Array.from(keep) }); keep = []; } };
      for (let k = 0; k + per <= str.length; k += per) {
        const code = per === 2 ? (str[k] << 8) | str[k + 1] : str[k];
        const w0 = f ? f.width(code) : 500;
        const adv = (w0 / 1000) * gs.fs + gs.tc + (f && code === f.space ? gs.tw : 0);
        const trm = mul(mul([gs.fs * gs.th, 0, 0, gs.fs, 0, gs.rise], tm), gs.ctm);
        const [cx, cy] = apply(trm, (w0 / 1000) * 0.5, 0.3);
        if (gs.fs && inside(cx, cy)) {
          flushKeep();
          // keep the following glyphs where they were: move by this glyph's advance
          parts.push({ n: -(adv / gs.fs) * 1000 });
          removedHere++;
        } else {
          for (let m = 0; m < per; m++) keep.push(str[k + m]);
        }
        tm = mul([1, 0, 0, 1, adv * gs.th, 0], tm);
      }
      flushKeep();
      return removedHere;
    };

    for (const o of ops) {
      const a = o.args;
      const v = (k) => (a[k] && a[k].t === 'num' ? a[k].v : 0);
      switch (o.op) {
        case 'm': case 'l': case 'c': case 'v': case 'y': case 're': {
          if (pathStart < 0) pathStart = o.start;
          const nums = a.filter((q) => q.t === 'num').map((q) => q.v);
          if (o.op === 're' && nums.length === 4) {
            [[0, 0], [nums[2], 0], [0, nums[3]], [nums[2], nums[3]]].forEach(([dx, dy]) => pts.push(apply(gs.ctm, nums[0] + dx, nums[1] + dy)));
          } else {
            for (let k = 0; k + 1 < nums.length; k += 2) pts.push(apply(gs.ctm, nums[k], nums[k + 1]));
          }
          break;
        }
        case 'h': break;
        case 'n': pathStart = -1; pts = []; break;
        case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'S': case 's': {
          if (pathStart >= 0 && pts.length) {
            const xs = pts.map((q) => q[0]);
            const ys = pts.map((q) => q[1]);
            const bb = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
            const mv = (count.moves || []).find((r) => bb.x0 >= r.x - 1 && bb.x1 <= r.x + r.width + 1 && bb.y0 >= r.y - 1 && bb.y1 <= r.y + r.height + 1);
            if (within(bb)) { edits.push({ start: pathStart, end: o.end, text: '' }); count.n++; }
            else if (mv) {
              // the same shape, slid along with the rest of its line
              const [a, b, c, d] = gs.ctm;
              const det = a * d - b * c;
              if (det) {
                const ux = (d * mv.dx - c * mv.dy) / det;
                const uy = (-b * mv.dx + a * mv.dy) / det;
                edits.push({ start: pathStart, end: o.end, text: 'q 1 0 0 1 ' + fmtNum(ux) + ' ' + fmtNum(uy) + ' cm ' + String.fromCharCode.apply(null, bytes.subarray(pathStart, o.end)) + ' Q' });
                count.n++;
              }
            }
          }
          pathStart = -1;
          pts = [];
          break;
        }
        case 'q': stack.push(Object.assign({}, gs)); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': gs.ctm = mul([v(0), v(1), v(2), v(3), v(4), v(5)], gs.ctm); break;
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case 'Tc': gs.tc = v(0); break;
        case 'Tw': gs.tw = v(0); break;
        case 'Tz': gs.th = v(0) / 100; break;
        case 'TL': gs.tl = v(0); break;
        case 'Ts': gs.rise = v(0); break;
        case 'Tf': gs.font = a[0] && a[0].t === 'name' ? getFont(a[0].v) : null; gs.fs = v(1); break;
        case 'Td': tlm = mul([1, 0, 0, 1, v(0), v(1)], tlm); tm = tlm.slice(); break;
        case 'TD': gs.tl = -v(1); tlm = mul([1, 0, 0, 1, v(0), v(1)], tlm); tm = tlm.slice(); break;
        case 'Tm': tlm = [v(0), v(1), v(2), v(3), v(4), v(5)]; tm = tlm.slice(); break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm.slice(); break;
        case 'Tj': case "'": case '"': case 'TJ': {
          let prefix = '';
          if (o.op === "'" || o.op === '"') {
            if (o.op === '"') { gs.tw = v(0); gs.tc = v(1); prefix = fmtNum(v(0)) + ' Tw ' + fmtNum(v(1)) + ' Tc '; }
            tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
            tm = tlm.slice();
            prefix += 'T* ';
          }
          const parts = [];
          let removed = 0;
          if (o.op === 'TJ') {
            const arr = a[0] && a[0].t === 'arr' ? a[0].v : [];
            for (const el2 of arr) {
              if (el2.t === 'str') removed += show(el2.v, parts);
              else if (el2.t === 'num') {
                parts.push({ n: el2.v });
                tm = mul([1, 0, 0, 1, (-el2.v / 1000) * gs.fs * gs.th, 0], tm);
              }
            }
          } else {
            const s = a[a.length - 1];
            if (s && s.t === 'str') removed += show(s.v, parts);
          }
          if (removed) {
            count.n += removed;
            const body = parts.map((p) => (p.s ? '<' + hexOf(p.s) + '>' : fmtNum(p.n))).join(' ');
            edits.push({ start: o.start, end: o.end, text: prefix + '[' + body + '] TJ' });
          }
          break;
        }
        case 'Do': {
          if (depth > 4 || !xobjs || !a[0] || a[0].t !== 'name') break;
          let form = null;
          try { form = xobjs.lookup(N(a[0].v)); } catch (e) { form = null; }
          if (!form || !form.dict) break;
          const st = form.dict.lookup(N('Subtype'));
          if (st && st.decodeText() === 'Image') {
            // A picture (a scanned page is one): redact its pixels on download.
            const mask = form.dict.lookup(N('ImageMask'));
            if (mask && mask.asBoolean && mask.asBoolean()) break;
            const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, w]) => apply(gs.ctm, u, w));
            const xs = pts.map((q) => q[0]);
            const ys = pts.map((q) => q[1]);
            const bb = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
            const meets = (r) => r.x < bb.x1 && r.x + r.width > bb.x0 && r.y < bb.y1 && r.y + r.height > bb.y0;
            const hits = regions.filter(meets);
            const paints = (count.paints || []).filter((q) => meets(q.rect));
            const moved = (count.moves || []).filter(meets);
            if (!hits.length && !paints.length && !moved.length) break;
            const newName = a[0].v + '_np' + Math.random().toString(36).slice(2, 7);
            count.images.push({ xobjs, name: a[0].v, newName, ref: xobjs.get(N(a[0].v)), ctm: gs.ctm.slice(), hits, paints, moves: moved });
            edits.push({ start: o.start, end: o.end, text: '/' + newName + ' Do' });
            break;
          }
          if (!st || st.decodeText() !== 'Form') break;
          const fm = form.dict.lookup(N('Matrix'));
          const m = fm ? [0, 1, 2, 3, 4, 5].map((k) => num(fm.lookup(k))) : [1, 0, 0, 1, 0, 0];
          const fres = form.dict.lookup(N('Resources')) || resources;
          let inner;
          try { inner = contentBytes(form); } catch (e) { break; }
          const out = eraseIn(inner, fres, mul(m, gs.ctm), regions, ctx, count, depth + 1);
          if (out) {
            // a fresh copy of the form, so other pages that share it are untouched
            const copy = ctx.flateStream(out);
            for (const [k, val] of form.dict.entries()) {
              const key = k.asString();
              if (key !== '/Length' && key !== '/Filter' && key !== '/DecodeParms') copy.dict.set(k, val);
            }
            const newName = a[0].v + '_np' + Math.random().toString(36).slice(2, 7);
            xobjs.set(N(newName), ctx.register(copy));
            edits.push({ start: o.start, end: o.end, text: '/' + newName + ' Do' });
          }
          break;
        }
        default: break;
      }
    }
    if (!edits.length) return null;
    const enc = new TextEncoder();
    const chunks = [];
    let pos = 0;
    for (const e of edits) {
      chunks.push(bytes.subarray(pos, e.start), enc.encode(e.text));
      pos = e.end;
    }
    chunks.push(bytes.subarray(pos));
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  // Erase the text under regions (page space) from a page. Returns glyphs removed.
  // Repaint the covered parts of an image. PDF.js decodes it (any format a
  // PDF can hold: JPEG, fax, JBIG2, JPEG 2000…) by rendering a one-image
  // scratch PDF at one pixel per image pixel.
  async function redactImage(doc, ref, ctm, hits, paints, moves) {
    const L = PDFLib;
    const N = (k) => L.PDFName.of(k);
    const img = doc.context.lookup(ref);
    if (!img || !img.dict) return null;
    const W = num(img.dict.lookup(N('Width')));
    const H = num(img.dict.lookup(N('Height')));
    if (!W || !H) return null;
    const bpc = num(img.dict.lookup(N('BitsPerComponent')));
    const filt = img.dict.lookup(N('Filter'));
    const filters = filt ? (filt.asArray ? filt.asArray().map((f) => f.toString()) : [filt.toString()]) : [];
    const bilevel = bpc === 1 || filters.some((f) => /CCITT|JBIG2/.test(f));

    const tmp = await L.PDFDocument.create();
    const copied = L.PDFObjectCopier.for(doc.context, tmp.context).copy(img);
    const tref = tmp.context.register(copied);
    const tpage = tmp.addPage([W, H]);
    const xname = tpage.node.newXObject('Im', tref);
    tpage.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(W, 0, 0, H, 0, 0), L.drawObject(xname), L.popGraphicsState());
    const pdoc = await loadPdfJs((await tmp.save()).buffer);
    const scale = Math.min(1, Math.sqrt(40e6 / (W * H)));
    const cw = Math.max(1, Math.round(W * scale));
    const ch = Math.max(1, Math.round(H * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cw, ch);
    const pg = await pdoc.getPage(1);
    await pg.render({ canvasContext: g, viewport: pg.getViewport({ scale: cw / W }) }).promise;
    pdoc.destroy();

    // page space → image unit square → pixels (image row 0 is the top)
    const [a, b, c, d, e, f] = ctm;
    const det = a * d - b * c;
    if (!det) return null;
    const toPx = (x, y) => {
      const u = (d * (x - e) - c * (y - f)) / det;
      const v = (a * (y - f) - b * (x - e)) / det;
      return [u * cw, (1 - v) * ch];
    };
    for (const r of hits) {
      g.fillStyle = r.color || '#ffffff';
      g.beginPath();
      [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]].forEach(([x, y], k) => {
        const [px0, py0] = toPx(x, y);
        if (k) g.lineTo(px0, py0); else g.moveTo(px0, py0);
      });
      g.closePath();
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = g.fillStyle;
      g.stroke();
    }
    // Moved words: lift the block of pixels, clear where it was, set it down
    // further along the line.
    for (const mv of moves || []) {
      const c0 = toPx(mv.x, mv.y + mv.height);
      const c1 = toPx(mv.x + mv.width, mv.y);
      const rx = Math.round(Math.min(c0[0], c1[0]));
      const ry = Math.round(Math.min(c0[1], c1[1]));
      const rw = Math.round(Math.abs(c1[0] - c0[0]));
      const rh = Math.round(Math.abs(c1[1] - c0[1]));
      if (rw < 1 || rh < 1) continue;
      const d0 = toPx(mv.x, mv.y);
      const d1 = toPx(mv.x + mv.dx, mv.y + mv.dy);
      const block = g.getImageData(rx, ry, rw, rh);
      g.fillStyle = mv.color || '#ffffff';
      g.fillRect(rx, ry, rw, rh);
      g.putImageData(block, Math.round(rx + d1[0] - d0[0]), Math.round(ry + d1[1] - d0[1]));
    }
    // Replacement words go into the scan itself, slightly soft, so they look
    // scanned rather than typed on top.
    const painted = [];
    for (const q of paints || []) {
      const [ax, ay] = toPx(q.o[0], q.o[1]);
      const [bx, by] = toPx(q.along[0], q.along[1]);
      const [ux, uy] = toPx(q.up[0], q.up[1]);
      if (ax < -20 || ay < -20 || ax > cw + 20 || ay > ch + 20) continue;
      const perPt = Math.hypot(bx - ax, by - ay) / 10;
      const perPtY = Math.hypot(ux - ax, uy - ay) / 10;
      if (!perPt) continue;
      g.save();
      g.translate(ax, ay);
      g.rotate(Math.atan2(by - ay, bx - ax));
      g.scale(q.scaleX || 1, perPtY / perPt);
      g.font = fontCss(q.item, q.item.size * perPt);
      g.fillStyle = q.item.color;
      g.textBaseline = 'alphabetic';
      if ('filter' in g) g.filter = 'blur(' + Math.max(0.3, perPt * 0.12).toFixed(2) + 'px)';
      g.fillText(q.text, 0, 0);
      g.restore();
      painted.push(q.id);
    }

    const ctx = doc.context;
    if (bilevel) {
      // black-and-white scans stay 1 bit per pixel, so the file stays small
      const data = g.getImageData(0, 0, cw, ch).data;
      const rowBytes = Math.ceil(cw / 8);
      const bits = new Uint8Array(rowBytes * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const k = (y * cw + x) * 4;
          if (data[k] * 0.299 + data[k + 1] * 0.587 + data[k + 2] * 0.114 >= 128) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
      return { ref: ctx.register(ctx.flateStream(bits, { Type: 'XObject', Subtype: 'Image', Width: cw, Height: ch, ColorSpace: 'DeviceGray', BitsPerComponent: 1 })), painted };
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    const jpg = new Uint8Array(await blob.arrayBuffer());
    return { ref: ctx.register(ctx.stream(jpg, { Type: 'XObject', Subtype: 'Image', Width: cw, Height: ch, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' })), painted };
  }

  // Returns { n: glyphs and images changed, painted: ids of paints drawn into images }.
  async function eraseText(doc, page, regions, paints, moves) {
    const L = PDFLib;
    const N = (k) => L.PDFName.of(k);
    const ctx = doc.context;
    page.node.normalize();
    const contents = page.node.Contents();
    const none = { n: 0, painted: new Set() };
    if (!contents) return none;
    const streams = contents instanceof L.PDFArray ? contents.asArray().map((r, k) => contents.lookup(k)) : [contents];
    const parts = [];
    for (const s of streams) { try { parts.push(contentBytes(s)); } catch (e) { return none; } }
    const len = parts.reduce((t, p) => t + p.length + 1, 0);
    const bytes = new Uint8Array(len);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; bytes[at++] = 10; }
    // Resources may be shared with other pages: work on this page's own copy.
    const res = page.node.Resources() ? page.node.Resources().clone(ctx) : ctx.obj({});
    const xo = res.lookup(N('XObject'));
    if (xo) res.set(N('XObject'), xo.clone(ctx));
    const count = { n: 0, images: [], paints: paints || [], moves: moves || [] };
    const out = eraseIn(bytes, res, [1, 0, 0, 1, 0, 0], regions, ctx, count, 0);
    if (!out) return none;
    let redacted = 0;
    const painted = new Set();
    for (const im of count.images) {
      let fresh = null;
      try { fresh = await redactImage(doc, im.ref, im.ctm, im.hits, im.paints, im.moves); } catch (e) { fresh = null; }
      im.xobjs.set(N(im.newName), fresh ? fresh.ref : im.ref);
      if (fresh) { redacted++; fresh.painted.forEach((id) => painted.add(id)); }
    }
    page.node.set(N('Resources'), res);
    // an array, as normalize() left it, so later wrapping can add to it
    page.node.set(N('Contents'), ctx.obj([ctx.register(ctx.flateStream(out))]));
    return { n: count.n + redacted, painted };
  }

  /* ============================================================ export */

  function hexRgb(hex) {
    const h = String(hex || '#000000').replace('#', '');
    return PDFLib.rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
  }

  function dataUrlBytes(src) {
    const b64 = src.split(',')[1] || '';
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function exportPdf(rec) {
    await loadLibs();
    const L = PDFLib;
    let base;
    try { base = await L.PDFDocument.load(rec.sources[0], { updateMetadata: false }); }
    catch (e) {
      if (/encrypt/i.test(String(e && e.message))) throw new Error('This PDF is password-protected, so it cannot be saved with changes.');
      throw e;
    }
    const warnings = [];
    // fonts painted into scans must be ready before the canvas draws them
    if (typeof NpFonts !== 'undefined') await Promise.all((rec.items || []).filter((i) => i.font).map((i) => NpFonts.load(i.font).catch(() => null)));

    // form values
    if (rec.fields && Object.keys(rec.fields).length) {
      const form = base.getForm();
      for (const [name, val] of Object.entries(rec.fields)) {
        try {
          const f = form.getField(name);
          if (f instanceof L.PDFTextField) f.setText(String(val));
          else if (f instanceof L.PDFCheckBox) { if (val) f.check(); else f.uncheck(); }
          else if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList) { if (val) f.select(String(val)); else f.clear(); }
          else if (f instanceof L.PDFRadioGroup) { if (val) f.select(String(val)); }
        } catch (e) { warnings.push('field “' + name + '”'); }
      }
      try { form.updateFieldAppearances(await base.embedFont(L.StandardFonts.Helvetica)); }
      catch (e) { form.acroForm.dict.set(L.PDFName.of('NeedAppearances'), L.PDFBool.True); }
    }

    // pages, in the edited order
    const others = [];
    const orig = base.getPages();
    const final = [];
    for (const entry of rec.pages) {
      let page;
      if (entry.src === -1) page = base.addPage([entry.w, entry.h]);
      else if (entry.src === 0) page = orig[entry.index];
      else {
        if (!others[entry.src]) others[entry.src] = await L.PDFDocument.load(rec.sources[entry.src], { ignoreEncryption: true, updateMetadata: false });
        [page] = await base.copyPages(others[entry.src], [entry.index]);
      }
      final.push({ entry, page, baseRot: entry.src === -1 ? 0 : page.getRotation().angle });
    }
    for (let i = base.getPageCount() - 1; i >= 0; i--) base.removePage(i);
    for (const f of final) base.addPage(f.page);

    // drawings
    const fonts = {};
    const fontFor = async (it) => {
      if (it.font) {
        const key = 'f:' + NpFonts.cssFamily(it.font);
        if (!(key in fonts)) {
          try {
            if (typeof fontkit === 'undefined') await loadScript(VENDOR + 'pdf-lib/fontkit.umd.min.js');
            if (!S.fontkitOn) { base.registerFontkit(fontkit); S.fontkitOn = base; }
            if (S.fontkitOn !== base) base.registerFontkit(fontkit);
            fonts[key] = await base.embedFont(await NpFonts.bytes(it.font), { subset: true });
          } catch (e) { fonts[key] = null; }
        }
        if (fonts[key]) return fonts[key];
      }
      const names = {
        sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
        serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
        mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique']
      }[it.family || 'sans'];
      const n = names[(it.bold ? 1 : 0) + (it.italic ? 2 : 0)];
      if (!fonts[n]) fonts[n] = await base.embedFont(L.StandardFonts[n]);
      return fonts[n];
    };
    const images = new Map();
    let replaced = 0;
    let erased = 0;
    let coveredNothing = 0;
    let overflowed = 0;

    for (const { entry, page, baseRot } of final) {
      const R = ((baseRot + entry.rotate) % 360 + 360) % 360;
      page.setRotation(L.degrees(R));
      const items = (rec.items || []).filter((i) => i.page === entry.uid);
      const ocr = rec.ocr && rec.ocr[entry.uid] && rec.ocr[entry.uid].rot === R ? rec.ocr[entry.uid].lines : [];
      if (!items.length && !ocr.length) continue;
      const regions = [];
      const box = page.getCropBox();
      // Text under edits and white-out is removed from the file, not just hidden.
      const paints = [];
      const moves = [];
      const shiftsShown = [];
      const layouts = new Map();
      for (const it of items) {
        if (it.cover) regions.push(Object.assign(rectToPdf(R, box, it.cover.x, it.cover.y, it.cover.w, it.cover.h), { color: it.cover.color }));
        if (it.type === 'whiteout') regions.push(Object.assign(rectToPdf(R, box, it.x, it.y, it.w, it.h), { color: it.color }));
        if (it.anchored) {
          const lay = layoutEdit(it);
          layouts.set(it.id, lay);
          for (const c of lay.covers) regions.push(Object.assign(rectToPdf(R, box, c.x, c.y, c.w, c.h), { color: it.bg }));
          if (lay.shift) {
            const sh = lay.shift;
            const a0 = toPdf(R, box, sh.x0, sh.y0);
            const a1 = toPdf(R, box, sh.x0 + sh.dx, sh.y0);
            moves.push(Object.assign(rectToPdf(R, box, sh.x0, sh.y0, sh.x1 - sh.x0, sh.y1 - sh.y0), { dx: a1[0] - a0[0], dy: a1[1] - a0[1], color: it.bg }));
            shiftsShown.push(sh);
          }
          if (it.scan) {
            lay.runs.forEach((r, k) => paints.push({
              id: it.id + ':' + k, text: r.text, item: it, scaleX: r.scaleX,
              rect: rectToPdf(R, box, r.x, r.base - it.size, textWidth(r.text, it), it.size * 1.3),
              o: toPdf(R, box, r.x, r.base), along: toPdf(R, box, r.x + 10, r.base), up: toPdf(R, box, r.x, r.base - 10)
            }));
          }
        }
      }
      let painted = new Set();
      let erasedHere = 0;
      if (regions.length || paints.length || moves.length) {
        let res = { n: 0, painted: new Set() };
        try { res = await eraseText(base, page, regions, paints, moves); } catch (e) { /* page left as it was */ }
        erasedHere = res.n;
        painted = res.painted;
        erased += res.n;
        if (regions.length && !res.n) coveredNothing++;
      }
      // Keep the page's own drawing state from leaking into ours.
      page.node.normalize();
      const ctx = base.context;
      page.node.wrapContentStreams(ctx.register(ctx.contentStream([L.pushGraphicsState()])), ctx.register(ctx.contentStream([L.popGraphicsState()])));

      if (ocr.length) {
        // invisible text over the scan, so the PDF can be searched and copied;
        // nothing is written back inside an area that was just erased
        const font = await fontFor({ family: 'sans' });
        const key = page.node.newFontDictionary(font.name, font.ref);
        const rad = (R * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const inRegion = (x, y) => regions.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
        // word by word, so a white-out over part of a line drops just those words
        for (const l of ocr) {
          const words = l.words && l.words.length ? l.words : [{ t: l.text, x: l.x, w: l.w }];
          for (const wd0 of words) {
            const sh = shiftsShown.find((q) => wd0.x >= q.x0 - 0.5 && wd0.x + wd0.w <= q.x1 + 0.5 && l.base > q.y0 && l.base - l.size * 0.5 < q.y1);
            const wd = sh ? Object.assign({}, wd0, { x: wd0.x + sh.dx }) : wd0;
            const mid = toPdf(R, box, wd0.x + wd0.w / 2, l.base - l.size * 0.3);
            if (!sh && inRegion(mid[0], mid[1])) continue;
            let safe = '';
            for (const ch of wd.t) { try { font.encodeText(ch); safe += ch; } catch (e) { safe += '?'; } }
            const wAt = font.widthOfTextAtSize(safe + ' ', l.size);
            if (!wAt || !safe) continue;
            const [x, y] = toPdf(R, box, wd.x, l.base);
            // q/Q: invisible mode and squeeze are graphics state and would leak into the visible text drawn next
            page.pushOperators(L.pushGraphicsState(), L.beginText(), L.setFontAndSize(key, l.size), L.setTextRenderingMode(L.TextRenderingMode.Invisible),
              L.setCharacterSqueeze(clamp((wd.w / font.widthOfTextAtSize(safe, l.size)) * 100, 10, 1000)), L.setTextMatrix(cos, sin, -sin, cos, x, y), L.showText(font.encodeText(safe)), L.endText(), L.popGraphicsState());
          }
        }
      }

      for (const it of items) if (it.cover) {
        page.drawRectangle(Object.assign(rectToPdf(R, box, it.cover.x, it.cover.y, it.cover.w, it.cover.h), { color: hexRgb(it.cover.color) }));
      }
      // Edits of the page's own words: the old words are already gone from
      // the file, so a patch is only needed if erasing failed.
      for (const it of items) {
        if (!it.anchored) continue;
        const lay = layouts.get(it.id);
        if (!erasedHere) for (const c of lay.covers) page.drawRectangle(Object.assign(rectToPdf(R, box, c.x, c.y, c.w, c.h), { color: hexRgb(it.bg) }));
        const matched = await fontFor(it);
        const charset = it.font && matched && matched.getCharacterSet ? new Set(matched.getCharacterSet()) : null;
        for (let k = 0; k < lay.runs.length; k++) {
          const r = lay.runs[k];
          const font = charset && [...r.text].some((ch) => !charset.has(ch.codePointAt(0)) && ch !== ' ')
            ? await fontFor(Object.assign({}, it, { font: null })) : matched;
          let safe = '';
          for (const ch of r.text) { try { font.encodeText(ch); safe += ch; } catch (e) { safe += '?'; replaced++; } }
          if (!safe) continue;
          const [x, y] = toPdf(R, box, r.x, r.base);
          if (painted.has(it.id + ':' + k)) {
            // drawn into the scan already: add it as invisible text so it can be searched and copied
            const fkey = page.node.newFontDictionary(font.name, font.ref);
            const rad = (R * Math.PI) / 180;
            page.pushOperators(L.pushGraphicsState(), L.beginText(), L.setFontAndSize(fkey, it.size), L.setTextRenderingMode(L.TextRenderingMode.Invisible),
              L.setTextMatrix(Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), x, y), L.showText(font.encodeText(safe)), L.endText(), L.popGraphicsState());
          } else {
            if (r.scaleX < 1) page.pushOperators(L.pushGraphicsState(), L.setCharacterSqueeze(r.scaleX * 100));
            page.drawText(safe, { x, y, size: it.size, font, color: hexRgb(it.color), rotate: L.degrees(R) });
            if (r.scaleX < 1) page.pushOperators(L.popGraphicsState());
          }
          if (r.overflow) overflowed++;
        }
      }
      for (const it of items) {
        if (it.type === 'whiteout') page.drawRectangle(Object.assign(rectToPdf(R, box, it.x, it.y, it.w, it.h), { color: hexRgb(it.color) }));
        else if (it.type === 'highlight') page.drawRectangle(Object.assign(rectToPdf(R, box, it.x, it.y, it.w, it.h), { color: hexRgb(it.color), opacity: 0.4, blendMode: L.BlendMode.Multiply }));
        else if (it.type === 'box') {
          const r = rectToPdf(R, box, it.x + it.width / 2, it.y + it.width / 2, Math.max(0, it.w - it.width), Math.max(0, it.h - it.width));
          page.drawRectangle(Object.assign(r, { borderColor: hexRgb(it.color), borderWidth: it.width }));
        } else if (it.type === 'image') {
          let img = images.get(it.src);
          if (!img) {
            img = /^data:image\/jpeg/.test(it.src) ? await base.embedJpg(dataUrlBytes(it.src)) : await base.embedPng(dataUrlBytes(it.src));
            images.set(it.src, img);
          }
          const [x, y] = toPdf(R, box, it.x, it.y + it.h);
          page.drawImage(img, { x, y, width: it.w, height: it.h, rotate: L.degrees(R) });
        } else if (it.type === 'ink') {
          const top = box.y + box.height;
          const pts = it.points.map(([dx, dy]) => toPdf(R, box, dx, dy));
          let d = 'M' + (pts[0][0] - box.x) + ' ' + (top - pts[0][1]);
          for (let i = 1; i < pts.length; i++) d += 'L' + (pts[i][0] - box.x) + ' ' + (top - pts[i][1]);
          if (pts.length === 1) d += 'l0.01 0';
          page.drawSvgPath(d, { x: box.x, y: top, borderColor: hexRgb(it.color), borderWidth: it.width, borderLineCap: L.LineCapStyle.Round });
        } else if (it.type === 'text' && it.text && !it.anchored) {
          const font = await fontFor(it);
          const lines = it.text.replace(/\t/g, '    ').split('\n');
          lines.forEach((line, i) => {
            let safe = '';
            for (const ch of line) {
              try { font.encodeText(ch); safe += ch; } catch (e) { safe += '?'; replaced++; }
            }
            if (!safe) return;
            const [x, y] = toPdf(R, box, it.x, it.y + BASELINE[it.family || 'sans'] * it.size + i * LINE * it.size);
            page.drawText(safe, { x, y, size: it.size, font, color: hexRgb(it.color), rotate: L.degrees(R) });
          });
        }
      }
    }
    const bytes = await base.save({ updateFieldAppearances: false });
    if (replaced) api.toast(replaced + ' character' + (replaced === 1 ? '' : 's') + ' could not be written with the PDF’s standard fonts and became “?”.', 6000);
    if (overflowed) api.toast('Some edited text is longer than the space it had, so it runs past the end of its line. Shorten it if it overlaps something.', 7000);
    if (coveredNothing) api.toast('Some covered areas had nothing underneath to remove except drawings. Those are hidden, but still inside the file.', 7000);
    if (warnings.length) api.toast('Some form fields could not be filled: ' + warnings.slice(0, 3).join(', '), 6000);
    return new Blob([bytes], { type: 'application/pdf' });
  }

  /* ============================================================ wiring */

  function init(a) {
    api = a;
    const tb = $('#pdf-toolbar');
    tb.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    tb.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !S.rec) return;
      if (b.dataset.pdfTool) setTool(b.dataset.pdfTool);
      const act = b.dataset.pdf;
      if (act === 'undo') undo();
      if (act === 'redo') redo();
      if (act === 'image') pickImage();
      if (act === 'sign') signature();
      if (act === 'zoom-in') zoom('in');
      if (act === 'zoom-out') zoom('out');
      if (act === 'pages') document.body.classList.toggle('pdf-thumbs-open');
      if (act === 'ocr') runOcr('scanned');
    });
    $('#pdf-scroller').addEventListener('scroll', () => { if (!S.raf) S.raf = requestAnimationFrame(() => { S.raf = 0; updatePageStatus(); }); }, { passive: true });
    window.addEventListener('resize', () => { if (S.rec && S.fit && document.body.classList.contains('pdf-mode')) fitWidth(); });
    const addInput = $('#pdf-add-input');
    addInput.addEventListener('change', async () => {
      const files = Array.from(addInput.files);
      addInput.value = '';
      for (const f of files) await addPagesFrom(f);
    });
  }

  async function newRecord(buffer) {
    await loadLibs();
    const doc = await loadPdfJs(buffer);
    const n = doc.numPages;
    let text = '';
    try {
      for (let i = 1; i <= Math.min(n, 3) && text.length < 4000; i++) {
        const c = await (await doc.getPage(i)).getTextContent();
        text += c.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('') + '\n';
      }
    } catch (e) { /* text is only for search */ }
    doc.destroy();
    return { pages: Array.from({ length: n }, (_, i) => ({ uid: uid(), src: 0, index: i, rotate: 0 })), text: text.replace(/[ \t]+/g, ' ').trim() };
  }

  async function suggestOcr(rec) {
    // a PDF whose first page has no text of its own is almost always a scan
    const first = S.info.get(rec.pages[0] && rec.pages[0].uid);
    if (!first || !first.page || (rec.ocr && Object.keys(rec.ocr).length)) return;
    if ((await nativeTextCount(first)) === 0 && S.rec === rec) api.toast('This PDF has no text the app can edit directly: it is a scan, or its letters were saved as drawn shapes. Click “Read text” to make its words editable and searchable.', 7000);
  }

  window.NpPdf = {
    // the closest fonts from the last look-based match, for diagnosing a poor match
    get lastMatch() { return S.lastMatch; },
    init, open, close, newRecord,
    export: exportPdf,
    undo, redo, zoom,
    setTool, onKey,
    rotateCurrent: (dir) => { const c = currentPage(); if (c) rotatePage(c.entry.uid, dir); },
    deleteCurrent: () => { const c = currentPage(); if (c) deletePage(c.entry.uid); },
    insertBlank,
    ocr: (scope) => runOcr(scope),
    copyText: copyPageText,
    addPages: () => $('#pdf-add-input').click(),
    get active() { return !!S.rec; },
    finishEditing
  };
})();
