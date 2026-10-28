/* Noteshack — PDF editor.
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
  const vendorUrl = (path) => new URL(VENDOR + path, document.baseURI).href;
  const $ = (s, r = document) => r.querySelector(s);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const DPR = () => Math.min(2, window.devicePixelRatio || 1);
  // the app's own language (js/i18n.js)
  const _ = NpI18n.t;
  const _n = NpI18n.n;

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
    return { lsb: -m.actualBoundingBoxLeft * k, w: (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) * k, h: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * k };
  }
  // A word of a converted line set in another weight or style than the rest
  // of its line (a bold label, an italic aside) carries that as v.
  function runStyle(it, v) {
    if (!v || !it.font) return it;
    return Object.assign({}, it, { font: { id: it.font.id, weight: v.weight, style: v.style }, bold: v.weight >= 600, italic: v.style === 'italic' });
  }
  // every font file an item draws with
  function itemFonts(it) {
    const out = it.font ? [it.font] : [];
    for (const w of (it.conv && it.words) || []) if (w.v && it.font) out.push(runStyle(it, w.v).font);
    for (const v of (it.conv && it.tv) || []) if (v && it.font) out.push(runStyle(it, v).font);
    return out;
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
    bgAt: new Map(),      // page uid → when the background reader last changed it
    nodeBefore: new WeakMap(), // a box being edited → the undo snapshot from before the edit
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
      s.onerror = () => reject(new Error(_('Could not load the PDF tools. Check your connection and try again.')));
      document.head.append(s);
    });
  }

  function loadLibs() {
    if (libs) return libs;
    libs = (async () => {
      // PDF.js comes as modules; it puts itself on window.pdfjsLib as well
      try { await import(vendorUrl('pdfjs/pdf.min.mjs')); } catch (e) { throw new Error(_('Could not load the PDF tools. Check your connection and try again.')); }
      pdfjsLib.GlobalWorkerOptions.workerSrc = vendorUrl('pdfjs/pdf.worker.min.mjs');
      await loadScript(VENDOR + 'pdf-lib/pdf-lib.min.js');
    })();
    libs.catch(() => { libs = null; });
    return libs;
  }

  // one PDF.js worker for every document, kept for the visit: a document
  // closed does not stop it, and the next one does not wait to start another
  let pdfWorker = null;
  function sharedWorker() {
    if (!pdfWorker || pdfWorker.destroyed) pdfWorker = new pdfjsLib.PDFWorker({ name: 'noteshack' });
    return pdfWorker;
  }

  // A document's pages are drawn one at a time. Safari's engine mixes up
  // pictures when two pages of a document are drawn at once (page 1 came
  // out with page 2's scan), and one at a time costs the others nothing
  // noticeable: drawing shares one thread anyway. Every page comes through
  // getPage, so every drawing waits its turn; cancel still works on one
  // that has not started.
  function oneAtATime(doc) {
    let turn = Promise.resolve();
    const getPage = doc.getPage.bind(doc);
    doc.getPage = async (n) => {
      const page = await getPage(n);
      if (page.oneAtATime) return page;
      const render = page.render.bind(page);
      page.render = (opts) => {
        let task = null;
        let cancelled = false;
        const promise = turn.then(() => {
          if (cancelled) throw Object.assign(new Error('Rendering cancelled'), { name: 'RenderingCancelledException' });
          task = render(opts);
          return task.promise;
        });
        turn = promise.catch(() => {});
        return { promise, cancel: () => { cancelled = true; if (task) task.cancel(); } };
      };
      page.oneAtATime = true;
      return page;
    };
    return doc;
  }

  async function loadPdfJs(buffer) {
    return oneAtATime(await pdfjsLib.getDocument({
      worker: sharedWorker(),
      data: new Uint8Array(buffer.slice(0)), // PDF.js takes ownership of what it is given
      isEvalSupported: false,                 // no code generated from a PDF's contents
      enableXfa: false,
      // full addresses: the worker would read a relative one from its own folder
      cMapUrl: vendorUrl('pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: vendorUrl('pdfjs/standard_fonts/'),
      wasmUrl: vendorUrl('pdfjs/wasm/'),      // image decoders (fax-compressed scans, JPEG 2000, JBIG2) and color profiles
      iccUrl: vendorUrl('pdfjs/iccs/')
    }).promise);
  }
  // a document from loadPdfJs, finished with (its worker and memory freed)
  const closePdf = (doc) => { try { doc.loadingTask.destroy(); } catch (e) { /* ignore */ } };

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

  // An undo snapshot: the pages and form fields as text, and each item as
  // text plus its word boxes. A converted page's word boxes are most of a
  // document's size and never change once made (a change gives the item a
  // new array), so snapshots share them rather than copying them; and an
  // item unchanged since the last snapshot reuses its text from then. A
  // snapshot of a 700-page converted document costs a few hundred KB, not
  // the whole document again.
  // It also carries the time it was taken (t), so work done in the
  // background after it (pages read and made editable) is kept when the
  // snapshot is restored by undo or redo.
  const lastItemText = new Map(); // item id → its text in the last snapshot
  function snap() {
    const r = S.rec;
    return {
      t: Date.now(), pages: JSON.stringify(r.pages), fields: JSON.stringify(r.fields),
      items: r.items.map((it) => {
        const { words, ...rest } = it;
        let s = JSON.stringify(rest);
        const prev = lastItemText.get(it.id);
        if (prev === s) s = prev; else lastItemText.set(it.id, s);
        return { id: it.id, s, w: words || null };
      })
    };
  }
  const sameState = (a, b) => a.pages === b.pages && a.fields === b.fields && a.items.length === b.items.length &&
    a.items.every((x, k) => x.s === b.items[k].s && x.w === b.items[k].w);
  // the items of a snapshot, as objects again
  const snapItems = (st) => st.items.map((x) => { const o = JSON.parse(x.s); if (x.w) o.words = x.w; return o; });

  function commit(before) {
    if (sameState(before, snap())) return;
    S.undo.push(before);
    if (S.undo.length > 150) S.undo.shift();
    S.redo = [];
    changed();
  }

  function changed() {
    S.rec.pageCount = S.rec.pages.length;
    updateConvUi();
    api.changed();
    updateUndoButtons();
  }

  async function restore(snapshot) {
    const prevPages = JSON.stringify(S.rec.pages);
    const st = { t: snapshot.t, pages: JSON.parse(snapshot.pages), fields: JSON.parse(snapshot.fields), items: snapItems(snapshot) };
    // pages the background reader changed after this snapshot keep its work
    for (const [uidv, at] of S.bgAt) {
      if (st.t && at <= st.t) continue;
      const cur = S.rec.pages.find((q) => q.uid === uidv);
      const k = st.pages.findIndex((q) => q.uid === uidv);
      if (cur && k >= 0) st.pages[k] = JSON.parse(JSON.stringify(cur));
      st.items = st.items.filter((i) => !(i.page === uidv && i.conv)).concat(S.rec.items.filter((i) => i.page === uidv && i.conv));
    }
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

  // Options to draw a page at k pixels per point (offset in pixels), turned
  // by the page's skew so a scan that went through the scanner crooked is
  // drawn straight.
  const paperOf = (info) => (info.entry.skew && info.entry.paper) || '#fff';
  function renderOpts(info, g, k, ox, oy) {
    ox = ox || 0;
    oy = oy || 0;
    const o = { canvasContext: g, viewport: info.page.getViewport({ scale: k, rotation: info.rot, offsetX: ox, offsetY: oy }) };
    const a = ((info.entry.skew || 0) * Math.PI) / 180;
    if (a) {
      const cx = (info.w / 2) * k + ox;
      const cy = (info.h / 2) * k + oy;
      const c = Math.cos(-a);
      const sn = Math.sin(-a);
      o.transform = [c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy];
    }
    return o;
  }

  async function open(rec) {
    close();
    S.rec = rec;
    rec.items = rec.items || [];
    rec.fields = rec.fields || {};
    rec.pages = rec.pages || [];
    S.undo = [];
    lastItemText.clear();
    S.redo = [];
    S.sel = null;
    S.fit = true;
    const stage = $('#pdf-pages');
    stage.replaceChildren(el('div', { class: 'pdf-msg' }, _('Opening PDF…')));
    try {
      await loadLibs();
      S.docs = [];
      for (const buf of rec.sources) S.docs.push(await loadPdfJs(buf));
    } catch (e) {
      const pw = e && e.name === 'PasswordException';
      stage.replaceChildren(el('div', { class: 'pdf-msg' }, pw
        ? _('This PDF is password-protected. Remove the password in another app, then open it again.')
        : _('This PDF could not be opened: {reason}', { reason: e.message || e })));
      return;
    }
    if (S.rec !== rec) return;
    if (!rec.pages.length) {
      for (let i = 0; i < S.docs[0].numPages; i++) rec.pages.push({ uid: uid(), src: 0, index: i, rotate: 0 });
      rec.pageCount = rec.pages.length;
    }
    try {
      await loadForms();
      await build();
    } catch (e) {
      // loaded, but its pages could not be laid out: say so, not a blank page
      if (S.rec === rec) stage.replaceChildren(el('div', { class: 'pdf-msg' }, _('This PDF opened, but its pages could not be shown: {reason}. Saving a fresh copy of it from another program often helps.', { reason: (e && e.message) || e })));
      return;
    }
    setTool(S.tool === 'image' || S.tool === 'sign' ? 'select' : S.tool);
    updateUndoButtons();
    toggleOriginal(false);
    S.lex = new Map();
    for (const o of Object.values(rec.ocr || {})) learnWords(S.lex, o.lines || []);
    updateReadAllUi();
    // reading the whole document carries on where it stopped
    if (rec.readAll) setReadAll(true);
    else suggestOcr(rec);
    if (rec.ocr && Object.values(rec.ocr).some((o) => !o.rules)) {
      api.toast(_('This PDF’s text was read by an older version of the app. Read the page again (Pages → Keep this page as scanned, then click it with Edit text) for better edits.'), 9000);
    }
    // matched fonts from earlier sessions (and those made from the scan's
    // letters): load them, then redraw with them
    useScanFonts();
    const used = rec.items.flatMap(itemFonts);
    if (used.length && typeof NpFonts !== 'undefined') {
      Promise.all(used.map((f) => NpFonts.load(f).catch(() => null))).then(() => { if (S.rec === rec) renderAllOverlays(); });
    }
  }

  function close() {
    // stop reading pages of the document being closed (its work so far is saved)
    if (S.rec && saveSoon) { clearTimeout(saveSoon); saveSoon = 0; api.changed(); }
    RQ.gen++;
    RQ.want = [];
    RQ.running = new Map();
    for (const list of RQ.waiting.values()) list.forEach((res) => res());
    RQ.waiting = new Map();
    RQ.total = 0;
    RQ.whole = false;
    S.bgAt = new Map();
    if (S.observer) S.observer.disconnect();
    if (S.thumbObserver) S.thumbObserver.disconnect();
    for (const d of S.docs) closePdf(d);
    S.docs = [];
    S.pageCache.clear();
    S.info.clear();
    S.fields = [];
    S.rec = null;
    S.fix = null;
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
      info.el.addEventListener('contextmenu', (e) => {
        // while typing, the browser's own menu (with its spelling suggestions)
        if (e.target.closest('[contenteditable="true"], [contenteditable="plaintext-only"], input, textarea')) return;
        const n = e.target.closest('[data-fix]');
        if (!n) return;
        e.preventDefault();
        if (S.editing) finishEditing();
        openWordMenu(e, info, n.dataset.fix);
      });
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
    showReadAllIfScans();
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
    placeFix();
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
    const clean = cleanSig(info);
    info.cleanState = clean;
    const c = info.canvas;
    const dpr = DPR();
    const W = Math.max(1, Math.floor(info.w * scale * dpr));
    const H = Math.max(1, Math.floor(info.h * scale * dpr));
    c.style.width = info.w * scale + 'px';
    c.style.height = info.h * scale + 'px';
    if (!info.page) {
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (info.task) { try { info.task.cancel(); } catch (e) { /* ignore */ } }
    // drawn off screen and swapped in when finished, so the page never flashes blank
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const og = off.getContext('2d');
    og.fillStyle = paperOf(info);
    og.fillRect(0, 0, W, H);
    const task = info.page.render(renderOpts(info, og, scale * dpr));
    info.task = task;
    let done = true;
    try { await task.promise; } catch (e) { done = false; /* cancelled by a newer render */ }
    if (info.task === task) info.task = null;
    if (!done || !S.rec) return;
    if (clean) cleanCanvas(info, off);
    c.width = W;
    c.height = H;
    c.getContext('2d').drawImage(off, 0, 0);
    if (S.rec.items.some((i) => i.page === info.entry.uid && i.anchored && i.scan)) renderOverlay(info);
  }


  function updatePageStatus() {
    const n = S.rec ? S.rec.pages.length : 0;
    const cur = currentPage();
    const i = cur ? S.rec.pages.findIndex((p) => p.uid === cur.entry.uid) + 1 : 1;
    const t = _('Page {page} of {total}', { page: i, total: n });
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
    if (info.renderedScale && (info.cleanState || '') !== cleanSig(info)) renderPage(info);
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
      if (it.type === 'hand') {
        const b = handBox(it);
        layer.append(el('div', {
          class: 'pdf-hand' + (it.erased ? ' erased' : '') + (it.id === S.sel ? ' sel' : ''), 'data-id': it.id,
          title: it.erased ? _('Erased handwriting. Select it and choose Put back to restore it.') : _('Handwriting, left as it was scanned. Select it to erase it.'),
          style: 'left:' + px(b.x) + ';top:' + px(b.y) + ';width:' + px(b.w) + ';height:' + px(b.h)
        }));
        if (it.erased && it.id === S.sel && it.parts) {
          it.parts.forEach((q, k) => layer.append(el('div', {
            class: 'pdf-hand-part' + (q.keep ? ' keep' : ''), 'data-hand': it.id, 'data-part': k,
            title: q.keep ? _('Kept as part of the form. Click to erase it too.') : _('Erased. Click to keep it.'),
            style: 'left:' + px(q.x0 - 0.5) + ';top:' + px(q.y0 - 0.5) + ';width:' + px(q.x1 - q.x0 + 1) + ';height:' + px(q.y1 - q.y0 + 1)
          })));
        }
        continue;
      }
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
    if (S.showOriginal) {
      // proofreading: every word read from the scan, clickable to correct it
      for (const it of mine) {
        if (!it.conv) continue;
        for (const r of convLayout(it)) {
          if (!r.o) continue;
          const w = r.o;
          layer.append(el('div', {
            class: 'pdf-proof' + (doubtful(w) ? ' doubt' : ''), 'data-fix': it.id + ':' + it.words.indexOf(w), title: _('Read as “{word}”. Click to correct it.', { word: w.t }),
            style: 'left:' + px(w.x0 - 1) + ';top:' + px(w.y0 - 1) + ';width:' + px(w.x1 - w.x0 + 2) + ';height:' + px(w.y1 - w.y0 + 2)
          }));
        }
      }
      // lines left as scanned: what OCR read is only in the searchable text, but can be wrong too
      const used = new Set(mine.filter((i) => i.conv).map((i) => i.origKey));
      for (const t of info.text || []) {
        if (!t.scan || used.has(t.key)) continue;
        const li = +t.key.split(':ocr')[1].split('.')[0];
        for (const w of t.words) {
          layer.append(el('div', {
            class: 'pdf-proof doubt', 'data-fix': 'ocr:' + li + ':' + w.ri, title: _('Read as “{word}”. Click to correct it.', { word: w.t }),
            style: 'left:' + px(w.x0 - 1) + ';top:' + px(w.y0 - 1) + ';width:' + px(w.x1 - w.x0 + 2) + ';height:' + px(w.y1 - w.y0 + 2)
          }));
        }
      }
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
    const editingPara = it.para && S.editPrep && (itemById(S.editPrep) || {}).para === it.para;
    if (editingPara && it.id !== S.editPrep) return document.createDocumentFragment();
    // being edited: shown as it will be drawn (see editorEl)
    if (editingPara || (it.conv && S.editPrep === it.id)) return editorEl(it);
    if (it.type === 'text' && it.conv && S.editPrep !== it.id) {
      const frag = document.createDocumentFragment();
      const lay = convLayout(it);
      if (sel && lay.length) {
        const y0 = (it.words.length ? Math.min(...it.words.map((w) => w.y0)) : it.base - it.size * 0.75) - 1;
        const y1 = (it.words.length ? Math.max(...it.words.map((w) => w.y1)) : it.base + it.size * 0.25) + 1;
        const x1 = Math.max(...lay.map((r) => r.x + measureRun(r.text, r.st, it.smallCaps).w * r.scaleX));
        frag.append(el('div', { class: 'pdf-conv-box', style: 'left:' + px(lay[0].x - 1) + ';top:' + px(y0) + ';width:' + px(x1 - lay[0].x + 2) + ';height:' + px(y1 - y0) }));
      }
      for (const r of lay) {
        const d = el('div', {
          class: 'pdf-item pdf-textbox pdf-run pdf-conv' + (r.o && doubtful(r.o) ? ' pdf-doubt' : ''), 'data-id': it.id,
          'data-fix': r.o ? it.id + ':' + it.words.indexOf(r.o) : null, title: r.o && doubtful(r.o) ? _('This word may have been misread: right-click to check it against the scan') : null,
          style: 'left:' + px(r.x) + ';top:' + px(r.base - BASELINE[it.family] * it.size) + ';font-size:' + px(it.size) + ';font-family:' + familyCss(r.st).replace(/"/g, "'") +
            ';color:' + it.color + ';font-weight:' + (r.st.font ? r.st.font.weight : r.st.bold ? 700 : 400) + ';font-style:' + (r.st.italic ? 'italic' : 'normal') +
            (Math.abs(r.scaleX - 1) > 0.002 ? ';transform:scaleX(' + r.scaleX.toFixed(3) + ');transform-origin:0 0' : '')
        });
        if (it.smallCaps) d.append(...scParts(r.text, it.smallCaps).map((q) => (q.small ? el('span', { style: 'font-size:' + q.k + 'em' }, q.t) : document.createTextNode(q.t))));
        else d.textContent = r.text;
        frag.append(d);
      }
      return frag;
    }
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
          ';color:' + it.color + ';font-weight:' + (it.font ? it.font.weight : it.bold ? 700 : 400) + ';font-style:' + (it.italic ? 'italic' : 'normal') +
          (it.smallCaps ? ';font-variant:small-caps' : '')
      });
      d.textContent = it.anchored || it.conv ? it.text.replace(/\s+/g, ' ') : it.text;
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
    if (!out.length && ocrFits(ocr, info.entry, info.rot)) {
      ocr.lines.forEach((l, li) => ocrPhrases(l, ocr.rules).forEach((ph, pi) => out.push({
        key: info.entry.uid + ':ocr' + li + '.' + pi, str: ph.map((w) => w.t).join(' '), x: ph[0].x0, base: l.base, size: l.size,
        top: Math.min(...ph.map((w) => w.y0)), w: ph[ph.length - 1].x1 - ph[0].x0, words: ph, scan: true, fontName: null, family: 'sans'
      })));
    }
    info.text = out;
    return out;
  }

  // Split an OCR line into the pieces a person would edit separately: table
  // borders that OCR reads as "|", and wide gaps between columns, end a piece.
  function ocrPhrases(l, rules) {
    const raw = l.words && l.words.length ? l.words : [{ t: l.text, x: l.x, w: l.w }];
    const words = [];
    for (const [ri, w] of raw.entries()) {
      let t = w.t;
      // The word "I", read as "|": a bar no taller than the letters, sitting
      // on the line, followed closely by a word in lower case ("I attest").
      // A separator between two labels ("name | Nombre") or a piece of a
      // table border is none of those.
      if (/^[|¦]$/.test(t) && w.h != null) {
        const sz = l.size || l.h;
        const nx = raw[ri + 1];
        if (w.h < sz * 0.85 && (w.y + w.h) <= (l.base || w.y + w.h) + sz * 0.12 && nx && /^\p{Ll}/u.test(nx.t) && nx.x - (w.x + w.w) < sz * 0.5) t = 'I';
      }
      let x0 = w.x;
      let x1 = w.x + w.w;
      const y0 = w.y != null ? w.y : l.y;
      const y1 = w.y != null ? w.y + w.h : l.y + l.h;
      const per = (x1 - x0) / Math.max(1, t.length);
      if (/^[|¦\[\]]+$/.test(t)) { words.push({ sep: true }); continue; }
      let after = false;
      while (/^[|¦]/.test(t)) { t = t.slice(1); x0 += per; words.push({ sep: true }); }
      while (/[|¦]$/.test(t)) { t = t.slice(0, -1); x1 -= per; after = true; }
      if (t) words.push({ t, x0, x1, y0, y1, sw: w.sw, c: w.c, ri });
      if (after) words.push({ sep: true });
    }
    const phrases = [];
    let cur = [];
    const gap = (l.h || l.size) * 1.3;
    // a table border found while reading the page, standing between two words
    const ruleBetween = (a, b) => (rules || []).some((r) => r.x > a.x1 - 0.5 && r.x < b.x0 + 0.5 && r.y0 < Math.max(a.y1, b.y1) && r.y1 > Math.min(a.y0, b.y0));
    for (const w of words) {
      const prev = cur[cur.length - 1];
      if (w.sep || (prev && (w.x0 - prev.x1 > gap || ruleBetween(prev, w)))) { if (cur.length) phrases.push(cur); cur = []; if (w.sep) continue; }
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
    const used = new Set(S.rec.items.flatMap((i) => i.keys || (i.origKey ? [i.origKey] : [])));
    const frag = document.createDocumentFragment();
    for (const t of items) {
      if (used.has(t.key)) continue;
      frag.append(el('div', { class: 'pdf-target', 'data-key': t.key, title: _('Click to edit'), 'aria-label': _('Edit: {text}', { text: t.str }), style: 'left:' + px(t.x) + ';top:' + px(t.top) + ';width:' + px(Math.max(t.w, 2)) + ';height:' + px(t.base - t.top + t.size * 0.25) }));
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
      const btn = (icon, label, fn, disabled) => el('button', { type: 'button', class: 'icon-btn sm', 'data-icon': icon, title: label, 'aria-label': _('{action}, page {page}', { action: label, page: i + 1 }), disabled: !!disabled, onclick: (ev) => { ev.stopPropagation(); fn(); } });
      const li = el('li', { class: 'pdf-thumb', 'data-uid': entry.uid },
        el('button', { type: 'button', class: 'pdf-thumb-open', 'aria-label': _('Go to page {page}', { page: i + 1 }), onclick: () => scrollToPage(entry.uid) },
          el('canvas', { class: 'pdf-thumb-canvas', width: 112, height: Math.round(112 * ratio) }),
          el('span', { class: 'pdf-thumb-num' }, String(i + 1))),
        el('div', { class: 'pdf-thumb-actions' },
          btn('rotateL', _('Rotate left'), () => rotatePage(entry.uid, -1)),
          btn('rotateR', _('Rotate right'), () => rotatePage(entry.uid, 1)),
          btn('up', _('Move up'), () => movePage(entry.uid, -1), i === 0),
          btn('down', _('Move down'), () => movePage(entry.uid, 1), i === n - 1),
          btn('trash', _('Delete page'), () => deletePage(entry.uid), n === 1)));
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
    ctx.fillStyle = paperOf(info);
    ctx.fillRect(0, 0, c.width, c.height);
    try { await info.page.render(renderOpts(info, ctx, scale)).promise; } catch (e) { /* ignore */ }
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
    if (S.rec.items.some((i) => i.page === uidv && (i.anchored || i.conv || i.type === 'hand'))) {
      api.toast(_('This page has text edits tied to its original lines. Rotate it before editing text, or undo the edits first.'), 6000);
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
    if (S.rec.pages.length <= 1) { api.toast(_('A PDF needs at least one page.')); return; }
    const before = snap();
    S.rec.pages = S.rec.pages.filter((p) => p.uid !== uidv);
    S.rec.items = S.rec.items.filter((i) => i.page !== uidv);
    commit(before);
    await build();
    api.toast(_('Page deleted. Undo (Ctrl+Z) brings it back.'));
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
    try { doc = await loadPdfJs(buf); } catch (e) { api.toast(_('“{name}” could not be opened as a PDF.', { name: file.name })); return; }
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
    api.toast(_n(doc.numPages, 'Added {n} page from “{name}”', 'Added {n} pages from “{name}”', { name: file.name }));
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
    if (t === 'edit' && S.rec) api.toast(_('Click any text on the page to change it.'), 2400);
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
    if (e.target.closest('.pdf-field') || e.target.closest('.pdf-fix')) return;
    if (S.fix) closeFix(true);
    // one piece of erased handwriting: keep it, or erase it after all
    const part = e.target.closest('.pdf-hand-part');
    if (part) {
      e.preventDefault();
      const it = itemById(part.dataset.hand);
      const q = it && it.parts && it.parts[+part.dataset.part];
      if (q) { const before = snap(); q.keep = !q.keep; commit(before); renderOverlay(info); }
      return;
    }
    // proofreading against the scan (Original on): a click on a word corrects
    // what OCR read; otherwise a click edits, and checking is on right-click
    const fixNode = e.target.closest('[data-fix]');
    if (fixNode && S.showOriginal) {
      e.preventDefault();
      if (S.editing) finishEditing();
      openFix(info, fixNode.dataset.fix);
      return;
    }
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
      if (item && item.type === 'hand') { e.preventDefault(); select(item.id); return; }
      const target = e.target.closest('.pdf-target');
      if (item && item.type === 'text') { e.preventDefault(); startEditing(item.id); return; }
      if (target) { e.preventDefault(); editOriginal(info, target.dataset.key); return; }
      if (isConv(info.entry.uid)) { e.preventDefault(); startEraseArea(e, info, x, y); return; }
      // a scanned page not read yet: read it now
      if (info.text && !info.text.length && info.page) { e.preventDefault(); clickRead(info, x, y); return; }
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
      if (item.anchored || item.conv || item.type === 'hand' || (!moved && Math.hypot(dx, dy) * S.scale < 3)) return;
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

  // On a page made editable, a box dragged with Edit text over writing the
  // app did not find erases the pen strokes in it: the printed text read
  // there, long lines and printed marks stay.
  function startEraseArea(e, info, x0, y0) {
    const preview = el('div', { class: 'pdf-erase-area' });
    info.layer.append(preview);
    let rect = null;
    drag(e, (ev) => {
      const [x, y] = pointIn(ev, info);
      rect = { x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
      Object.assign(preview.style, { left: px(rect.x), top: px(rect.y), width: px(rect.w), height: px(rect.h) });
    }, async () => {
      preview.remove();
      if (!rect || rect.w < 4 || rect.h < 4) return;
      const it = { id: uid(), type: 'hand', page: info.entry.uid, area: true, words: [{ x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h }], erased: false };
      const before = snap();
      S.rec.items.push(it);
      await setHand([it], true, before);
      if (it.parts && !it.parts.some((q) => !q.keep)) {
        // nothing there to erase
        S.rec.items = S.rec.items.filter((i) => i !== it);
        S.undo.pop();
        renderOverlay(info);
        api.toast('Nothing to erase was found in that box. Printed text the app read, lines and printed marks are never erased this way; to clear everything in an area, use White-out.', 6000);
        return;
      }
      select(it.id);
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
    S.editPrep = it.anchored || it.conv ? id : null;
    renderOverlay(info);
    S.editPrep = null;
    S.editing = id;
    const node = info.layer.querySelector('.pdf-textbox[data-id="' + id + '"]');
    if (!node) return;
    node.classList.add('editing');
    // the page's own text: the paper shows through, whatever its color
    if (it.conv || it.anchored) node.classList.add('pdf-own');
    try { node.contentEditable = 'plaintext-only'; } catch (e) { node.contentEditable = 'true'; }
    if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
    node.spellcheck = true;
    if (!isNew) S.nodeBefore.set(node, snap());
    node.dataset.isNew = isNew ? '1' : '';
    node.addEventListener('keydown', (e) => {
      // Escape while composing a character (Chinese, Japanese…) cancels the
      // character, not the editing
      if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); node.blur(); }
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
    const before = node.dataset.isNew ? null : S.nodeBefore.get(node) || snap();
    let text = node.innerText.replace(/\r/g, '').replace(/\n$/, '');
    if (it.anchored || it.conv) text = text.replace(/\s+/g, ' ').trim();
    if (it.conv && it.para) {
      if (reflowPara(it.para, text)) commit(before);
      renderOverlay(info);
      renderStyleBar();
      return;
    }
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
      const prev = snap();
      prev.items = prev.items.filter((x) => x.id !== id);
      if (!text.trim()) {
        S.rec.items = S.rec.items.filter((i) => i.id !== id);
        S.sel = null;
      } else {
        it.text = text;
        measure1(it, node);
        commit(prev);
      }
    } else {
      if (!text.trim() && !it.cover && !it.anchored && !it.conv) {
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
    if (it.anchored || it.conv) return;
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

  // The font size that makes each original word as wide as it is on the page,
  // taken word by word (median), so one odd word or gap cannot skew it, and
  // kept within a third of what the letters' height says.
  // The size at which the words' letters are as tall as on the page.
  function sizeFromInk(words, it, fallback) {
    const r = words.filter((w) => w.t.replace(/[^\p{L}\p{N}]/gu, '').length >= 2)
      .map((w) => (w.y1 - w.y0) / inkOf(w.t, Object.assign({}, it, { size: 1 })).h).filter((v) => v > 0 && isFinite(v));
    const m = median(r);
    return m ? Math.round(m * 10) / 10 : fallback;
  }

  function fitSize(words, it, fromHeight) {
    const r = words.filter((w) => w.t.replace(/[^\p{L}\p{N}]/gu, '').length >= 2)
      .map((w) => (w.x1 - w.x0) / inkOf(w.t, Object.assign({}, it, { size: 1 })).w)
      .filter((v) => v > 0 && isFinite(v)).sort((a, b) => a - b);
    if (!r.length) return fromHeight;
    const m = r[r.length >> 1];
    return m > fromHeight * 0.75 && m < fromHeight * 1.33 ? Math.round(m * 10) / 10 : fromHeight;
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
      size = fitSize(words, { family: fam, bold, italic: false }, Math.round(t.size * 10) / 10);
    } else {
      try {
        const f = info.page.commonObjs.get(t.fontName);
        const name = (f && (f.name || f.loadedName)) || '';
        bold = !!(f && f.bold) || /bold|black|heavy|semibold|demi/i.test(name);
        italic = !!(f && f.italic) || /italic|oblique/i.test(name);
      } catch (e) { /* font not resolved yet */ }
    }
    const limit = await lineLimit(info, t, words);
    const it = {
      id: uid(), type: 'text', page: info.entry.uid, origKey: key, anchored: true, scan: !!t.scan, limit,
      words, origText, text: origText, x: words[0].x0, base: t.base, y: t.base - BASELINE[fam] * size, heightSize: t.size,
      size, family: fam, color: ink.fg, bg: ink.bg, bold, italic
    };
    S.rec.items.push(it);
    renderOverlay(info);
    startEditing(it.id);
    const node = info.layer.querySelector('.pdf-textbox[data-id="' + it.id + '"]');
    if (node) { S.nodeBefore.set(node, before); node.dataset.fresh = '1'; }
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
          api.status(_('Matching the font…'), 'pending');
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
          api.saved();
        }
        S.fontCache.set(key, ref || null);
      }
      if (!ref) return;
      await NpFonts.load(ref);
    } catch (e) {
      api.saved();
      if (!S.fontWarned) { S.fontWarned = true; api.toast(_('The matching font could not be downloaded, so the closest standard font is used.'), 5000); }
      return;
    }
    if (!itemById(it.id)) return;
    it.font = { id: ref.id, weight: ref.weight, style: ref.style };
    it.bold = ref.weight >= 600;
    it.italic = ref.style === 'italic';
    const cat = NpFonts.CATALOG[ref.id] ? NpFonts.CATALOG[ref.id][1] : 'sans';
    it.family = cat === 'mono' ? 'mono' : cat === 'serif' ? 'serif' : 'sans';
    if (it.scan) it.size = fitSize(words, it, it.heightSize || it.size);
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
    g.fillStyle = paperOf(info);
    g.fillRect(0, 0, c.width, c.height);
    if (info.page) await info.page.render(renderOpts(info, g, k, -x0 * k, -y0 * k)).promise;
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
      i.onerror = () => reject(new Error(_('That image could not be read.')));
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
      } catch (e) { api.toast(e.message || _('That image could not be added.')); }
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
    const clear = el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; } }, _('Clear'));
    const body = el('div', { class: 'stack' },
      el('p', { class: 'dlg-text' }, _('Sign in the box with your mouse, finger or pen.')),
      canvas,
      el('div', { class: 'sig-row' }, clear,
        el('label', { class: 'toggle-row sig-remember' }, el('span', {}, _('Remember for next time')), el('input', { type: 'checkbox', class: 'switch', id: 'sig-remember', checked: true }))));
    const actions = [{ label: _('Cancel'), value: '' }];
    if (saved) actions.push({ label: _('Use saved signature'), value: 'saved' });
    actions.push({ label: _('Add signature'), value: 'ok', primary: true });
    const v = await api.dialog({ title: _('Signature'), body, actions, wide: true });
    if (v === 'saved' && saved) { await placeImage(saved, { signature: true }); return; }
    if (v !== 'ok') return;
    if (!drawn) { api.toast(_('Draw your signature first.')); return; }
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

  // Several readers at once, as many as the computer can spare, on
  // Tesseract's fast model; and one careful reader on the accurate model,
  // for the lines the fast ones were unsure of.
  // Readers, by the language they read (Tesseract's codes): a pool of fast
  // ones for pages, and one careful one for lines it is unsure of.
  const OCR = { pools: new Map(), bests: new Map(), size: 0 };
  // the languages scans can be read in: the document's, else English
  const READ_LANGS = { en: 'eng', es: 'spa', fr: 'fra', de: 'deu', pt: 'por', it: 'ita' };
  const readLangOf = (code) => READ_LANGS[String(code || '').split('-')[0]] || null;
  const readLang = () => readLangOf((S.rec && S.rec.lang) || NpLang.preferred()) || 'eng';

  function poolSize() {
    const cores = navigator.hardwareConcurrency || 2;
    const mem = navigator.deviceMemory || 4;
    return clamp(Math.min(cores - 1, mem <= 2 ? 1 : mem <= 4 ? 2 : 4), 1, 4);
  }

  async function tesseract() {
    if (!/^https?:$/.test(location.protocol)) {
      throw new Error(_('Reading text needs the app opened from its web address, not from a file on this computer.'));
    }
    if (typeof Tesseract === 'undefined') await loadScript(VENDOR + 'tesseract/tesseract.min.js');
  }

  function newReader(model, lang) {
    const abs = (path) => new URL(VENDOR + 'tesseract/' + path, location.href).href;
    return Tesseract.createWorker(lang, 1, {
      workerPath: abs('worker.min.js'),
      corePath: abs('tesseract-core-simd-lstm.wasm.js'),
      langPath: abs(model === 'fast' ? 'fast' : '').replace(/\/$/, ''),
      cacheMethod: 'none'
    });
  }

  // A reader that stops answering (Safari has been seen to lose one) must not
  // leave a page "reading" for ever: an answer is waited for this long, then
  // the readers are replaced and the page is tried once more.
  // (the tests shorten it, rather than wait two minutes)
  const readLimit = () => window.NP_READ_LIMIT || 120000;
  function inTime(promise, onLate) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((resolve, reject) => { timer = setTimeout(() => { onLate(); reject(new Error(_('The text reader stopped answering'))); }, readLimit()); })
    ]);
  }

  // { recognize(image) } that hands each page to whichever reader is free
  async function getOcr(lang = readLang()) {
    await tesseract();
    if (!OCR.pools.has(lang)) {
      const pool = (async () => {
        api.status(_('Getting text recognition ready…'), 'pending');
        const sch = Tesseract.createScheduler();
        // starting up counts too: a reader can hang while it loads
        const ws = await inTime(Promise.all(Array.from({ length: poolSize() }, () => newReader('fast', lang))), () => {});
        ws.forEach((w) => sch.addWorker(w));
        const drop = () => { if (OCR.pools.get(lang) === pool) OCR.pools.delete(lang); sch.terminate().catch(() => {}); };
        return { recognize: (img) => inTime(sch.addJob('recognize', img), drop), size: ws.length, lang };
      })();
      OCR.pools.set(lang, pool);
      pool.catch(() => OCR.pools.delete(lang));
    }
    return OCR.pools.get(lang);
  }

  async function getCareful(lang = readLang()) {
    await tesseract();
    if (!OCR.bests.has(lang)) {
      const best = (async () => {
        const w = await inTime(newReader('best', lang), () => {});
        // it is only ever given one line
        await w.setParameters({ tessedit_pageseg_mode: '7' });
        const drop = () => { if (OCR.bests.get(lang) === best) OCR.bests.delete(lang); w.terminate().catch(() => {}); };
        return { recognize: (img) => inTime(w.recognize(img), drop) };
      })();
      OCR.bests.set(lang, best);
      best.catch(() => OCR.bests.delete(lang));
    }
    return OCR.bests.get(lang);
  }


  // Lines the fast reader was unsure of, read again by the careful one; its
  // reading is kept where it is surer. Line and word boxes are in the
  // coordinates of the page image c.
  async function carefulLines(lines, c, lang) {
    // a word mixing letters and digits ("condici6n") is almost always a misread
    const odd = (t) => /\p{L}\d|\d\p{L}/u.test(t) && !/^\d+(st|nd|rd|th|s)$/i.test(t);
    const unsure = lines.filter((l) => l.text && l.text.trim() && (l.confidence < 85 || (l.words || []).some((w) => w.confidence < 80 || odd((w.text || '').replace(/[^\p{L}\p{N}]/gu, '')))));
    if (!unsure.length) return lines;
    let best;
    try { best = await getCareful(lang); } catch (e) { return lines; }
    const out = lines.slice();
    for (const l of unsure) {
      const b = l.bbox;
      const pad = Math.round((b.y1 - b.y0) * 0.25) + 2;
      const x0 = Math.max(0, b.x0 - pad);
      const y0 = Math.max(0, b.y0 - pad);
      const x1 = Math.min(c.width, b.x1 + pad);
      const y1 = Math.min(c.height, b.y1 + pad);
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      const crop = document.createElement('canvas');
      crop.width = x1 - x0;
      crop.height = y1 - y0;
      crop.getContext('2d').drawImage(c, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
      let data;
      try { ({ data } = await best.recognize(crop)); } catch (e) { continue; }
      const words = (data.words || []).filter((w) => w.text && w.text.trim()).map((w) => Object.assign({}, w, { bbox: { x0: w.bbox.x0 + x0, y0: w.bbox.y0 + y0, x1: w.bbox.x1 + x0, y1: w.bbox.y1 + y0 } }));
      if (!words.length) continue;
      // word by word: each word of the line takes the careful reading of the
      // same spot when that is surer, or when the fast one mixed letters and digits
      const core = (t) => (t || '').replace(/[^\p{L}\p{N}]/gu, '');
      let better = 0;
      const merged = (l.words || []).map((w) => {
        let pick = null;
        let ov = 0;
        for (const n of words) {
          const o = Math.min(w.bbox.x1, n.bbox.x1) - Math.max(w.bbox.x0, n.bbox.x0);
          if (o > ov) { ov = o; pick = n; }
        }
        if (!pick || ov < Math.min(w.bbox.x1 - w.bbox.x0, pick.bbox.x1 - pick.bbox.x0) * 0.5) return w;
        const wins = (odd(core(w.text)) && !odd(core(pick.text))) || pick.confidence > w.confidence + 3;
        if (!wins || pick.text.trim() === w.text.trim()) return w;
        better++;
        return Object.assign({}, w, { text: pick.text.trim(), confidence: Math.max(pick.confidence, w.confidence) });
      });
      if (!better) continue;
      out[out.indexOf(l)] = Object.assign({}, l, { text: merged.map((w) => w.text).join(' '), words: merged });
    }
    return out;
  }

  /* ----- words learned from the document ----- */

  // Words read surely anywhere in the document are collected; a word read
  // unsurely that is one letter away from one of them, seen at least twice,
  // is taken to be it ("condicién" → "condición").
  function learnWords(lex, lines) {
    for (const l of lines) for (const w of l.words || []) {
      const core = (w.t || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (w.c == null || w.c < 92 || core.length < 4 || !/^\p{L}+$/u.test(core)) continue;
      const k = core.toLowerCase();
      lex.set(k, (lex.get(k) || 0) + 1);
    }
  }

  function oneApart(a, b) {
    if (a === b || Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const ra = a.slice(i + (a.length >= b.length ? 1 : 0));
    const rb = b.slice(i + (b.length >= a.length ? 1 : 0));
    return ra === rb;
  }

  function fixFromWords(lex, lines) {
    let fixed = 0;
    for (const l of lines) {
      let changedLine = false;
      for (const w of l.words || []) {
        if (w.c == null || w.c >= 85) continue;
        const m = (w.t || '').match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
        const core = m[2];
        if (core.length < 4) continue;
        const low = core.toLowerCase();
        const cands = [];
        for (const [form, n] of lex) if (n >= 2 && oneApart(low, form)) cands.push([form, n]);
        if (!cands.length) continue;
        cands.sort((p, q) => q[1] - p[1]);
        // two words it could equally be: left for a person to check
        if (cands.length > 1 && cands[1][1] * 2 > cands[0][1]) continue;
        let fix = cands[0][0];
        // in the misread word's own capitals
        if (core.length > 1 && core === core.toUpperCase()) fix = fix.toUpperCase();
        else if (core[0] === core[0].toUpperCase()) fix = fix[0].toUpperCase() + fix.slice(1);
        w.t = m[1] + fix + m[3];
        w.c = 90;
        w.learned = true;
        changedLine = true;
        fixed++;
      }
      if (changedLine) l.text = l.words.map((w) => w.t).join(' ');
    }
    return fixed;
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
    g.fillStyle = paperOf(info);
    g.fillRect(0, 0, c.width, c.height);
    await info.page.render(renderOpts(info, g, k)).promise;
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const clean = withoutRules(c, px);
    const { data } = await worker.recognize(clean);
    data.lines = await carefulLines(data.lines || [], clean, worker.lang);
    // OCR's word boxes can be off by a letter's stem: move each edge to where
    // the ink actually starts and ends (on the copy without borders)
    const cd = clean.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, clean.width, clean.height).data;
    const inkAt = (x, y) => cd[(y * clean.width + x) * 4] * 0.299 + cd[(y * clean.width + x) * 4 + 1] * 0.587 + cd[(y * clean.width + x) * 4 + 2] * 0.114 < 150;
    const colInk = (x, y0, y1) => { if (x < 0 || x >= clean.width) return false; for (let y = Math.max(0, y0); y < Math.min(clean.height, y1); y++) if (inkAt(x, y)) return true; return false; };
    const rowInk = (y, x0, x1) => { if (y < 0 || y >= clean.height) return false; for (let x = Math.max(0, x0); x < Math.min(clean.width, x1); x++) if (inkAt(x, y)) return true; return false; };
    const snapBox = (bb) => {
      let x0 = Math.round(bb.x0);
      let x1 = Math.round(bb.x1);
      let y0 = Math.round(bb.y0);
      let y1 = Math.round(bb.y1);
      const h = y1 - y0;
      if (h < 4 || x1 - x0 < 2) return bb;
      const mx = Math.round(h * 0.5);
      const my = Math.round(h * 0.15);
      for (let n = 0; n < mx && colInk(x0 - 1, y0, y1); n++) x0--;
      while (x0 < x1 - 1 && !colInk(x0, y0, y1)) x0++;
      for (let n = 0; n < mx && colInk(x1, y0, y1); n++) x1++;
      while (x1 > x0 + 1 && !colInk(x1 - 1, y0, y1)) x1--;
      for (let n = 0; n < my && rowInk(y0 - 1, x0, x1); n++) y0--;
      while (y0 < y1 - 1 && !rowInk(y0, x0, x1)) y0++;
      for (let n = 0; n < my && rowInk(y1, x0, x1); n++) y1++;
      while (y1 > y0 + 1 && !rowInk(y1 - 1, x0, x1)) y1--;
      return { x0, x1, y0, y1 };
    };
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
      const words = (l.words || []).filter((w) => w.text && w.text.trim()).map((w) => {
        const bb = snapBox(w.bbox);
        return { t: w.text.trim(), x: bb.x0 / k, w: (bb.x1 - bb.x0) / k, y: bb.y0 / k, h: (bb.y1 - bb.y0) / k, sw: stroke(bb), c: Math.round(w.confidence || 0) };
      });
      lines.push({ text, x: b.x0 / k, y: top, w: (b.x1 - b.x0) / k, h: lineH, base, size: Math.round(size * 10) / 10, words });
    }
    return { lines, rules };
  }

  // Which way a scanned page has to turn to read upright: 0, 90, 180 or 270
  // degrees clockwise. Lines of text make a far more uneven profile across
  // them than along them, which tells upright-or-upside-down from sideways;
  // which of the two it is, OCR tells by how well a sample from the middle
  // of the page reads each way.
  async function detectTurn(worker, info) {
    if (!info.page) return 0;
    const k = 60 / 72;
    const W = Math.round(info.w * k);
    const H = Math.round(info.h * k);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    await info.page.render({ canvasContext: g, viewport: info.page.getViewport({ scale: k, rotation: info.rot }) }).promise;
    const d = g.getImageData(0, 0, W, H).data;
    const rows = new Float64Array(H);
    const cols = new Float64Array(W);
    let ink = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 128) { rows[y]++; cols[x]++; ink++; }
    }
    if (ink < 200) return 0;
    const unevenness = (a) => {
      let m = 0;
      for (const v of a) m += v;
      m /= a.length;
      let q = 0;
      for (const v of a) q += (v - m) * (v - m);
      return m ? q / a.length / (m * m) : 0;
    };
    const sideways = unevenness(cols) > unevenness(rows) * 1.25;
    const conf = async (turn) => {
      const kk = 150 / 72;
      const rot = (info.rot + turn) % 360;
      const vp = info.page.getViewport({ scale: kk, rotation: rot });
      const full = document.createElement('canvas');
      full.width = Math.round(vp.width);
      full.height = Math.round(vp.height);
      const fg = full.getContext('2d');
      fg.fillStyle = '#fff';
      fg.fillRect(0, 0, full.width, full.height);
      await info.page.render({ canvasContext: fg, viewport: vp }).promise;
      // where the ink is: the rows and columns with more of it than the paper's grain
      const fd = fg.getImageData(0, 0, full.width, full.height).data;
      const ry = new Uint32Array(full.height);
      const rx = new Uint32Array(full.width);
      for (let y = 0; y < full.height; y++) for (let x = 0; x < full.width; x++) {
        const i = (y * full.width + x) * 4;
        if (fd[i] * 0.299 + fd[i + 1] * 0.587 + fd[i + 2] * 0.114 < 110) { ry[y]++; rx[x]++; }
      }
      const span = (a, min) => { let lo = 0; let hi = a.length - 1; while (lo < hi && a[lo] < min) lo++; while (hi > lo && a[hi] < min) hi--; return [lo, hi + 1]; };
      const [y0, y1] = span(ry, Math.max(2, full.width * 0.004));
      const [x0, x1] = span(rx, Math.max(2, full.height * 0.004));
      if (y1 - y0 < 20 || x1 - x0 < 20) return 0;
      const crop = document.createElement('canvas');
      crop.width = x1 - x0;
      crop.height = Math.min(y1 - y0, Math.round(full.height * 0.45));
      crop.getContext('2d').drawImage(full, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
      // how many real words read surely: noise read as letters scores none
      try { const { data } = await worker.recognize(crop); return (data.words || []).filter((w) => w.confidence >= 80 && /[\p{L}\p{N}]{3}/u.test(w.text)).length; } catch (e) { return 0; }
    };
    if (!sideways) {
      const up = await conf(0);
      if (up >= 6) return 0;
      const down = await conf(180);
      return down >= 3 && down > up * 2 ? 180 : 0;
    }
    const a = await conf(90);
    const b = await conf(270);
    return Math.max(a, b) >= 3 ? (a >= b ? 90 : 270) : 0;
  }

  // OCR read from the page as it is drawn now (same quarter turn, same straightening)
  function ocrFits(ocr, entry, rot) {
    return !!ocr && ocr.rot === rot && (ocr.skew || 0) === (entry.skew || 0);
  }

  // How far a scan's lines slope, in degrees (clockwise positive), or 0. The
  // page's dark pixels are sheared at a range of angles; at the right one
  // the lines of text and table borders fall into the fewest, fullest rows.
  async function detectSkew(info) {
    if (!info.page) return 0;
    const k = 100 / 72;
    const W = Math.round(info.w * k);
    const H = Math.round(info.h * k);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    await info.page.render({ canvasContext: g, viewport: info.page.getViewport({ scale: k, rotation: info.rot }) }).promise;
    const d = g.getImageData(0, 0, W, H).data;
    const xs = [];
    const ys = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 128) { xs.push(x); ys.push(y); }
    }
    if (xs.length < 400) return { skew: 0 };
    // the paper: the usual color around the page's edge, to fill the corners
    // a straightened page turns away from
    const edge = [];
    const m = Math.max(2, Math.round(Math.min(W, H) * 0.02));
    for (let x = 0; x < W; x += 3) for (const y of [m, H - 1 - m]) edge.push((y * W + x) * 4);
    for (let y = 0; y < H; y += 3) for (const x of [m, W - 1 - m]) edge.push((y * W + x) * 4);
    const lumOf = (i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    edge.sort((p, q) => lumOf(p) - lumOf(q));
    const pi = edge[Math.floor(edge.length * 0.6)];
    const paper = '#' + [d[pi], d[pi + 1], d[pi + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    const step = Math.max(1, Math.floor(xs.length / 150000));
    const pad = Math.ceil(W * 0.2);
    const rows = new Float64Array(H + pad * 2);
    const score = (deg) => {
      const t = Math.tan((deg * Math.PI) / 180);
      rows.fill(0);
      for (let i = 0; i < xs.length; i += step) {
        const r = Math.round(ys[i] - xs[i] * t) + pad;
        if (r >= 0 && r < rows.length) rows[r]++;
      }
      let sum = 0;
      for (let r = 0; r < rows.length; r++) sum += rows[r] * rows[r];
      return sum;
    };
    let best = 0;
    let top = score(0);
    const flat = top;
    for (let a = -8; a <= 8.001; a += 0.25) { const v = score(a); if (v > top) { top = v; best = a; } }
    const coarse = best;
    for (let a = coarse - 0.25; a <= coarse + 0.25001; a += 0.025) { const v = score(a); if (v > top) { top = v; best = a; } }
    // too small to see, or no clear winner (a photo, an empty page)
    if (Math.abs(best) < 0.1 || top < flat * 1.03) return { skew: 0 };
    return { skew: Math.round(best * 100) / 100, paper };
  }

  async function nativeTextCount(info) {
    if (info.nativeCount === undefined) { info.text = null; await textItems(info); }
    return info.nativeCount;
  }

  // A scanned page: little or no text of its own, and a picture on it, or
  // many drawn shapes (letters saved as shapes). A blank page, or one with
  // just a page number, is not one.
  async function isScanPage(info) {
    if (!info.page || (await nativeTextCount(info)) >= 3) return false;
    if (info.isScan !== undefined) return info.isScan;
    let scan = false;
    try {
      const ops = await info.page.getOperatorList();
      const O = pdfjsLib.OPS;
      const pics = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintImageXObjectRepeat, O.paintInlineImageXObjectGroup]);
      const fillOps = new Set([O.fill, O.eoFill, O.fillStroke, O.eoFillStroke]);
      let fills = 0;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const f = ops.fnArray[i];
        if (pics.has(f)) { scan = true; break; }
        // a path and how it is painted come as one operation (constructPath, with the paint first)
        if (fillOps.has(f) || (f === O.constructPath && fillOps.has(ops.argsArray[i] && ops.argsArray[i][0]))) fills++;
      }
      if (fills > 150) scan = true;
    } catch (e) { scan = true; }
    info.isScan = scan;
    return scan;
  }

  /* ----- reading pages: one when it is clicked, or the whole document ----- */

  // A queue of pages to read, worked on by all the readers at once. A page
  // someone clicks goes to the front. Each page, once read, is made editable
  // there and then. Pages read in the background add no undo steps, and an
  // undo of anything else keeps them (see restore).
  const RQ = { want: [], running: new Map(), waiting: new Map(), retried: new Set(), gen: 0, total: 0, whole: false, stats: { turned: 0, straightened: 0, made: 0, found: 0, failed: 0 } };

  // whether a page is a scan still to read
  async function needsReading(info) {
    if (!info.page) return false;
    if (S.rec.ocr && ocrFits(S.rec.ocr[info.entry.uid], info.entry, info.rot)) return false;
    return isScanPage(info);
  }

  // Read one page now (ahead of any others); resolves when it is editable.
  function readPage(info) {
    const uidv = info.entry.uid;
    if (RQ.running.has(uidv)) return RQ.running.get(uidv);
    RQ.want = RQ.want.filter((u) => u !== uidv);
    RQ.want.unshift(uidv);
    const done = new Promise((res) => { if (!RQ.waiting.has(uidv)) RQ.waiting.set(uidv, []); RQ.waiting.get(uidv).push(res); });
    pump();
    return done;
  }

  // Keep every reader busy.
  function pump() {
    const rec = S.rec;
    const gen = RQ.gen;
    const start = (uidv) => {
      const p = (async () => {
        try { await readOne(rec, gen, uidv); } catch (e) {
          // tried once more with fresh readers; then the page stays as scanned
          if (!RQ.retried.has(uidv)) { RQ.retried.add(uidv); RQ.want.unshift(uidv); } else RQ.stats.failed = (RQ.stats.failed || 0) + 1;
        } finally {
          (RQ.waiting.get(uidv) || []).forEach((res) => res());
          RQ.waiting.delete(uidv);
          if (gen === RQ.gen) RQ.running.delete(uidv);
          if (S.rec === rec && gen === RQ.gen) { progress(); pump(); }
        }
      })();
      RQ.running.set(uidv, p);
    };
    while (RQ.want.length && RQ.running.size < Math.max(1, OCR.size || poolSize())) start(RQ.want.shift());
    if (!RQ.want.length && !RQ.running.size && S.rec === rec) finished();
  }

  function progress() {
    if (!RQ.whole || !RQ.total) return;
    const left = RQ.want.length + RQ.running.size;
    if (left) api.status(_('Reading the document: page {page} of {total}…', { page: Math.min(RQ.total, RQ.total - left + 1), total: RQ.total }), 'pending');
  }

  let saveSoon = 0;
  // Saving a large document after every page would be slow: background work
  // is saved every 15 seconds, and when reading stops.
  function bgChanged(now) {
    if (now) { clearTimeout(saveSoon); saveSoon = 0; changed(); return; }
    if (!saveSoon) saveSoon = setTimeout(() => { saveSoon = 0; if (S.rec) changed(); }, 15000);
  }

  // one page: turn it upright, straighten it, read it, make it editable
  async function readOne(rec, gen, uidv) {
    const alive = () => S.rec === rec && gen === RQ.gen;
    const info = S.info.get(uidv);
    if (!info || !alive() || !(await needsReading(info))) return;
    const ocr = await getOcr();
    OCR.size = ocr.size;
    const mark = () => S.bgAt.set(uidv, Date.now());
    if (!rec.items.some((i) => i.page === uidv)) {
      const turn = await detectTurn(ocr, info);
      if (!alive()) return;
      if (turn) {
        info.entry.rotate = (info.entry.rotate + turn) % 360;
        delete info.entry.skew;
        delete info.entry.paper;
        mark();
        await relayout(info);
        RQ.stats.turned++;
      }
      const { skew, paper } = await detectSkew(info);
      if (!alive()) return;
      if (skew !== (info.entry.skew || 0)) {
        if (skew) { info.entry.skew = skew; info.entry.paper = paper; } else { delete info.entry.skew; delete info.entry.paper; }
        mark();
        info.text = null;
        renderPage(info);
        const li = document.querySelector('.pdf-thumb[data-uid="' + uidv + '"]');
        if (li) renderThumb(li);
        if (skew) RQ.stats.straightened++;
      }
    }
    let { lines, rules } = await ocrPage(ocr, info);
    if (!alive()) return;
    // The language the page turns out to be in: until the document's language
    // is set by hand, what is read decides it, and a page read in another
    // language is read again in its own.
    if (rec.langAuto !== false && lines.length) {
      let code = null;
      try { code = await NpLang.detect(lines.map((l) => l.text).join(' ')); } catch (e) { code = null; }
      if (code && code !== rec.lang && alive()) {
        rec.lang = code;
        api.langChanged();
        const lang = readLangOf(code);
        if (lang && lang !== ocr.lang) {
          const again = await ocrPage(await getOcr(lang), info);
          if (!alive()) return;
          ({ lines, rules } = again);
        }
      }
    }
    // words learned from the document so far, this page's sure words included
    learnWords(S.lex, lines);
    fixFromWords(S.lex, lines);
    rec.ocr = rec.ocr || {};
    rec.ocr[uidv] = { rot: info.rot, skew: info.entry.skew || 0, lines, rules };
    if (lines.length) RQ.stats.found++;
    rec.text = ((rec.text || '') + '\n' + lines.map((l) => l.text).join('\n')).trim().slice(0, 200000);
    info.text = null;
    info.nativeCount = undefined;
    mark();
    // pages are made editable one at a time: it draws, and builds fonts
    S.convLock = (S.convLock || Promise.resolve()).then(async () => {
      if (!alive() || !lines.length || isConv(uidv)) return;
      if (await convertPage(info)) { RQ.stats.made++; mark(); }
    }).catch(() => {});
    await S.convLock;
    if (!alive()) return;
    renderOverlay(info);
    bgChanged();
  }

  // A page turned a quarter or half turn: its size and drawing again.
  async function relayout(info) {
    const m = await measure(info.entry);
    Object.assign(info, { W: m.W, H: m.H, x0: m.x0, y0: m.y0, rot: m.rot, w: m.w, h: m.h });
    info.el.style.width = info.w * S.scale + 'px';
    info.el.style.height = info.h * S.scale + 'px';
    info.text = null;
    info.nativeCount = undefined;
    renderPage(info);
    renderOverlay(info);
    const li = document.querySelector('.pdf-thumb[data-uid="' + info.entry.uid + '"]');
    if (li) renderThumb(li);
  }

  function finished() {
    const st = RQ.stats;
    const whole = RQ.whole;
    RQ.total = 0;
    RQ.whole = false;
    RQ.stats = { turned: 0, straightened: 0, made: 0, found: 0, failed: 0 };
    RQ.retried.clear();
    bgChanged(true);
    api.saveNow();
    if (!whole) {
      if (st.failed) api.toast(_('This page could not be read. Click it again with Edit text to try once more.'), 7000);
      return;
    }
    const parts = [];
    if (st.turned) parts.push(_n(st.turned, 'Turned {n} page the right way up.', 'Turned {n} pages the right way up.'));
    if (st.straightened) parts.push(_n(st.straightened, 'Straightened {n} crooked page.', 'Straightened {n} crooked pages.'));
    if (st.made) parts.push(_n(st.made, 'The whole document is read: {n} page is now editable and searchable.', 'The whole document is read: {n} pages are now editable and searchable.'));
    else if (st.found) parts.push(_('The whole document is read and searchable.'));
    else if (!st.failed) parts.push(_('No readable text was found on the scanned pages.'));
    if (st.failed) parts.push(_n(st.failed, '{n} page could not be read and is left as scanned; click it with Edit text to try again.', '{n} pages could not be read and are left as scanned; click one with Edit text to try again.'));
    api.toast(parts.join(' '), 8000);
  }

  // Read whole document: every scanned page not read yet, in order from the
  // page in view, in the background.
  async function setReadAll(on) {
    const rec = S.rec;
    if (!rec) return;
    rec.readAll = !!on;
    updateReadAllUi();
    changed();
    if (!on) {
      // pages being read finish; the rest wait until it is turned on again
      RQ.want = [];
      RQ.whole = false;
      if (!RQ.running.size) api.saved();
      return;
    }
    try { await tesseract(); } catch (e) { api.toast(e.message, 7000); rec.readAll = false; updateReadAllUi(); return; }
    const order = rec.pages.map((q) => S.info.get(q.uid)).filter(Boolean);
    const at = Math.max(0, order.indexOf(currentPage()));
    const todo = [];
    for (const info of order.slice(at).concat(order.slice(0, at))) {
      if (S.rec === rec && !RQ.running.has(info.entry.uid) && (await needsReading(info))) todo.push(info.entry.uid);
    }
    if (S.rec !== rec || !rec.readAll) return;
    if (!todo.length && !RQ.running.size) {
      api.toast(order.some((i) => rec.ocr && rec.ocr[i.entry.uid]) ? _('Every scanned page is already read.') : _('This PDF has no scanned pages: its text can be edited directly.'), 5000);
      return;
    }
    RQ.want = RQ.want.concat(todo.filter((u) => !RQ.want.includes(u)));
    RQ.total = RQ.want.length + RQ.running.size;
    RQ.whole = true;
    progress();
    pump();
  }

  function updateReadAllUi() {
    const sw = $('#pdf-readall');
    if (sw) sw.checked = !!(S.rec && S.rec.readAll);
  }

  // The switch is shown only for a PDF with a scanned page in it: on one
  // whose pages all have text of their own there is nothing to read. Looked
  // for in the background, stopping at the first scanned page found.
  let scanCheck = 0;
  async function showReadAllIfScans() {
    const wrap = $('#pdf-readall-wrap');
    if (!wrap || !S.rec) return;
    const rec = S.rec;
    const gen = ++scanCheck;
    let any = false;
    for (const p of rec.pages) {
      const info = S.info.get(p.uid);
      if (!info || !info.page) continue;
      if (await isScanPage(info)) { any = true; break; }
      if (S.rec !== rec || gen !== scanCheck) return;
    }
    if (S.rec !== rec || gen !== scanCheck) return;
    wrap.hidden = !any;
  }

  // Clicking a scanned page that is not read yet (Edit text): read just it,
  // then open the line clicked.
  async function clickRead(info, x, y) {
    if (info.reading) return;
    info.reading = true;
    const note = el('div', { class: 'pdf-reading', role: 'status' }, _('Reading this page…'));
    info.el.append(note);
    const rec = S.rec;
    try {
      await tesseract();
      await readPage(info);
    } catch (e) {
      api.toast(e.message || _('Text recognition failed.'), 7000);
    } finally {
      info.reading = false;
      note.remove();
    }
    if (S.rec !== rec) return;
    if (!isConv(info.entry.uid)) {
      const o = rec.ocr && rec.ocr[info.entry.uid];
      api.toast(o && o.lines.length ? _('The text on this page was read: click a word to edit it.') : _('No readable text was found on this page. Very faint or handwritten pages may not work.'), 5000);
      return;
    }
    // the line under the click, or the nearest one within reach
    let hit = null;
    let best = Infinity;
    for (const i of S.rec.items) {
      if (i.page !== info.entry.uid || !i.conv || !i.words.length) continue;
      const x0 = i.words[0].x0;
      const x1 = i.words[i.words.length - 1].x1;
      const y0 = Math.min(...i.words.map((w) => w.y0));
      const y1 = Math.max(...i.words.map((w) => w.y1));
      const d = Math.hypot(Math.max(0, x0 - x, x - x1), Math.max(0, y0 - y, y - y1));
      if (d < best && d <= i.size * 0.9) { best = d; hit = i; }
    }
    setTool('edit');
    if (hit) startEditing(hit.id);
  }

  async function copyPageText() {
    const info = currentPage();
    if (!info) return;
    const edited = new Map(S.rec.items.filter((i) => i.conv && i.page === info.entry.uid).map((i) => [i.origKey, i.text]));
    const items = (await textItems(info)).map((t) => (edited.has(t.key) ? Object.assign({}, t, { str: edited.get(t.key) }) : t)).filter((t) => t.str);
    if (!items.length) { api.toast(_('This page has no text to copy. If it is a scan, click it with Edit text first to read it.')); return; }
    const lines = [];
    let lastBase = null;
    for (const t of items.slice().sort((p, q) => (Math.abs(p.base - q.base) < p.size * 0.5 ? p.x - q.x : p.base - q.base))) {
      if (lastBase !== null && Math.abs(t.base - lastBase) < t.size * 0.5) lines[lines.length - 1] += ' ' + t.str;
      else lines.push(t.str);
      lastBase = t.base;
    }
    const text = lines.join('\n').replace(/ {2,}/g, ' ');
    try { await navigator.clipboard.writeText(text); api.toast(_('Copied the text of this page')); }
    catch (e) { api.toast(_('Your browser blocked copying. Select the text in the downloaded PDF instead.')); }
  }

  /* ----- making a scanned page's text real text ----- */

  // How Acrobat edits a scan: every line OCR read with confidence is taken off
  // the page (the scan's pixels are repainted with the paper around them, or
  // letters saved as shapes are removed) and drawn again as real text in the
  // matched font, at the size, weight and color it had. From then on the
  // page's text is ordinary text, so an edit always matches the lines around
  // it. Lines OCR was unsure of, and marks that are not words, stay as scanned.

  const isConv = (uidv) => !!S.rec && S.rec.items.some((i) => i.page === uidv && i.conv);
  const median = (a) => {
    const v = a.filter((x) => x != null && isFinite(x)).sort((p, q) => p - q);
    return v.length ? v[v.length >> 1] : null;
  };

  function convertible(words) {
    if (!words.some((w) => /[\p{L}\p{N}]/u.test(w.t))) return false;
    const cs = words.map((w) => w.c).filter((c) => c != null);
    // handwriting and specks read as letters come back with low confidence;
    // a mark read as a lone character or two (a box's rounded corner as "7",
    // a check box as "[1") needs to be read surely before it is retyped
    const avg = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 100;
    const chars = words.map((w) => w.t.replace(/[^\p{L}\p{N}]/gu, '')).join('').length;
    return avg >= (chars < 3 ? 92 : 70);
  }

  // How far right a line may grow: up to the next text on the same line, a
  // table border (found while reading a scan), or the page margin.
  async function lineLimit(info, t, words) {
    const lineEnd = words[words.length - 1].x1;
    const yTop = Math.min(...words.map((w) => w.y0));
    const yBot = Math.max(...words.map((w) => w.y1));
    let limit = info.w - Math.max(18, Math.min(words[0].x0, 72));
    for (const o of await textItems(info)) {
      if (o.key !== t.key && Math.abs(o.base - t.base) < t.size * 0.6 && o.x > lineEnd - 1) limit = Math.min(limit, o.x - t.size * 0.6);
    }
    const ocr = S.rec.ocr && S.rec.ocr[info.entry.uid];
    for (const r of (ocr && ocr.rules) || []) {
      if (r.x > lineEnd - 1 && r.y0 < yBot && r.y1 > yTop) limit = Math.min(limit, r.x - t.size * 0.35);
    }
    return limit;
  }

  // One font for most phrases of a weight on the page, matched on words
  // taken from across the page rather than from one line.
  async function styleFont(phrases, bold, samplesOf) {
    if (typeof NpFonts === 'undefined') return null;
    S.fontCache = S.fontCache || new Map();
    const key = 'page:' + (S.rec.id || '') + ':' + (bold ? 'b' : 'r');
    if (S.fontCache.has(key)) return S.fontCache.get(key);
    const long = (ws) => ws.filter((w) => w.t.replace(/[^\p{L}\p{N}]/gu, '').length >= 3).length;
    const pick = phrases.slice().sort((a, b) => long(b) - long(a)).slice(0, 10);
    const samples = [];
    // only words whose strokes agree with the weight being matched: a bold
    // label inside a regular line would pull the match toward a heavier font
    const agree = (w) => w.sw == null || (w.sw > S.boldCut) === bold;
    for (const ws of pick) samples.push(...samplesOf(ws.filter(agree), 3));
    let ref = null;
    try { ref = samples.length ? await NpFonts.identify(samples.slice(0, 24), { bold }) : null; } catch (e) { ref = null; }
    if (ref) { S.lastMatch = ref.ranking; await NpFonts.load(ref); }
    if (ref) S.fontCache.set(key, ref);
    return ref;
  }

  // Sizes a little apart are almost always one size measured with noise:
  // values within 6% of each other become their (word-weighted) median.
  function clusterSizes(list) {
    const v = list.slice().sort((a, b) => a.size - b.size);
    let group = [];
    const flush = () => {
      const all = [];
      for (const g of group) for (let k = 0; k < g.n; k++) all.push(g.size);
      const m = median(all);
      for (const g of group) g.size = Math.round(m * 10) / 10;
      group = [];
    };
    for (const g of v) {
      if (group.length && g.size > group[0].size * 1.06) flush();
      group.push(g);
    }
    if (group.length) flush();
  }

  // A line set in small caps: its words start with a full-height capital and
  // go on in shorter ones (or are all short, for words written in lower
  // case). Returns the words in their real case and the short letters'
  // height as a share of the tall ones, or null.
  function smallCapsOf(words, d, W, H, K, bgHex) {
    const caps = words.filter((w) => /\p{L}/u.test(w.t));
    if (!caps.length || caps.some((w) => /\p{Ll}/u.test(w.t))) return null;
    const bg = [1, 3, 5].map((p) => parseInt(bgHex.slice(p, p + 2), 16));
    const bgL = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114;
    // the top of the ink between two x positions inside a word's box
    const top = (w, xa, xb) => {
      const x0 = Math.max(0, Math.floor(xa * K));
      const x1 = Math.min(W, Math.ceil(xb * K));
      const y0 = Math.max(0, Math.floor(w.y0 * K) - 1);
      const y1 = Math.min(H, Math.ceil(w.y1 * K));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        if (bgL - (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) > 80) return y / K;
      }
      return null;
    };
    const m = words.map((w) => {
      const letters = w.t.replace(/[^\p{L}]/gu, '');
      if (letters.length < 2) return null;
      const per = (w.x1 - w.x0) / w.t.length;
      const t1 = top(w, w.x0, w.x0 + per * 0.9);
      // past the first letter, with room for a wide one (M, W)
      const t2 = top(w, w.x0 + per * (letters.length >= 3 ? 1.7 : 1.2), w.x1);
      return t1 == null || t2 == null ? null : { first: w.y1 - t1, rest: w.y1 - t2 };
    });
    const tall = Math.max(0, ...m.filter(Boolean).map((v) => v.first));
    if (!tall) return null;
    let mixed = 0;
    const ratios = [];
    const kind = m.map((v) => {
      if (!v) return 'keep';
      if (v.first > tall * 0.9 && v.rest < v.first * 0.86) { mixed++; ratios.push(v.rest / v.first); return 'title'; }
      if (v.first < tall * 0.86 && v.rest < tall * 0.86) { ratios.push(Math.max(v.first, v.rest) / tall); return 'lower'; }
      return 'keep';
    });
    if (!mixed) return null;
    const ratio = median(ratios);
    if (!(ratio > 0.55 && ratio < 0.88)) return null;
    const recase = (t, how) => (how === 'lower' ? t.toLowerCase() : how === 'title' ? t.replace(/^(\P{L}*\p{L})(.*)$/u, (all, a, b) => a + b.toLowerCase()) : t);
    return { ratio: Math.round(ratio * 1000) / 1000, words: words.map((w, i) => Object.assign({}, w, { t: recase(w.t, kind[i]) })) };
  }

  // Small caps drawn by hand: capitals at full size, lower-case letters as
  // capitals at k of it, in runs.
  function scParts(text, k) {
    const out = [];
    for (const ch of text) {
      const small = ch !== ch.toUpperCase();
      const last = out[out.length - 1];
      const t = small ? ch.toUpperCase() : ch;
      if (last && last.small === small) last.t += t;
      else out.push({ t, small, k: small ? k : 1 });
    }
    return out;
  }
  function measureRun(text, st, sc) {
    if (!sc) return inkOf(text, st);
    const parts = scParts(text, sc);
    let adv = 0;
    for (const p of parts) adv += textWidth(p.t, Object.assign({}, st, { size: st.size * p.k }));
    const first = inkOf(parts[0].t, Object.assign({}, st, { size: st.size * parts[0].k }));
    return { lsb: first.lsb, w: adv - first.lsb, h: first.h };
  }

  // The baseline, from where the words' letters stand: the bottom of words
  // with nothing hanging below the line (OCR's own baseline can be pulled
  // down by an underline or a fill-in line).
  function inkBase(words, fallback) {
    const flat = words.filter((w) => /[\p{L}\p{N}]/u.test(w.t) && !/[gjpqyQ,;()\[\]{}|\/_@$µßçþ]/u.test(w.t)).map((w) => w.y1);
    const m = median(flat);
    return m != null && Math.abs(m - fallback) < (words[0].y1 - words[0].y0) ? m : fallback;
  }

  // Each word's weight and slant, by which variant of the line's font its
  // letters look most like; returns per word a { weight, style } that differs
  // from the font's own, or null. Short words follow their neighbors.
  async function wordStyles(words, ref, samplesOf) {
    const ws = CATALOGW(ref.id);
    const near = (w) => ws.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a), ws[0]);
    const vars = [];
    for (const weight of [...new Set([ref.weight, near(400), near(700)])]) for (const style of ['normal', 'italic']) vars.push({ weight, style });
    const same = (a, b) => a.weight === b.weight && a.style === b.style;
    // a heavier or lighter weight only where the strokes say so too
    // a line's weight against the page's strokes; a word's against the
    // lighter and the heavier words of its own line (so in a line half in
    // bold, a bold word still stands out from the regular ones)
    const sws = words.map((w) => w.sw).filter((v) => v > 0).sort((a, b) => a - b);
    const lineSw = median(sws);
    const lightSw = sws.length ? sws[Math.floor((sws.length - 1) * 0.25)] : null;
    const heavySw = sws.length ? sws[Math.ceil((sws.length - 1) * 0.75)] : null;
    const allowed = (v, from, sw, word) => v.weight === from.weight || (sw != null && (word
      ? lineSw != null && (v.weight > from.weight ? sw > lightSw * 1.3 : sw < heavySw / 1.3)
      // near the line between regular and bold, how the letters look decides
      : v.weight > from.weight ? sw > S.boldCut * 0.9 : sw < S.boldCut * 1.1));
    const best = async (sm, from, sw, word) => {
      let top = null;
      let base = null;
      for (const v of vars) {
        if (!allowed(v, from, sw, word)) continue;
        const sc = await NpFonts.score(sm, { id: ref.id, weight: v.weight, style: v.style });
        if (sc == null) continue;
        if (same(v, from)) base = sc;
        if (!top || sc > top.sc) top = { v, sc };
      }
      if (!top || base == null || same(top.v, from)) return from;
      return top.sc - base >= (top.v.style !== from.style && !word ? 0.05 : 0.03) ? top.v : from;
    };
    // the line as a whole first, then each word against the line
    const all = samplesOf(words, 8);
    const line = all.length ? await best(all, { weight: ref.weight, style: ref.style }, median(words.map((w) => w.sw))) : { weight: ref.weight, style: ref.style };
    const pickOf = [];
    for (const w of words) {
      const sm = w.t.replace(/[^\p{L}\p{N}]/gu, '').length >= 2 ? samplesOf([w], 1) : [];
      pickOf.push(sm.length ? await best(sm, line, w.sw, true) : undefined);
    }
    // A slant or weight on one word alone is more likely a misjudged word than
    // emphasis, except a lead-in at the start of a line ("Note:"). Words too
    // short to judge do not count either way.
    // A lead-in in another weight has to show it in its strokes, against the rest of its line.
    const restSw = median(words.slice(1).map((w) => w.sw));
    const leadIn = (i, k) => i === 0 && (k === 'style' || (words[0].sw != null && restSw != null &&
      (pickOf[0].weight > line.weight ? words[0].sw > restSw * 1.25 : words[0].sw < restSw / 1.25)));
    const alone = (i, k) => words.length > 1 && pickOf[i] && !leadIn(i, k) && pickOf[i][k] !== line[k] &&
      !(pickOf[i - 1] && pickOf[i - 1][k] === pickOf[i][k]) && !(pickOf[i + 1] && pickOf[i + 1][k] === pickOf[i][k]);
    const judged = pickOf.map((v, i) => (v ? { weight: alone(i, 'weight') ? line.weight : v.weight, style: alone(i, 'style') ? line.style : v.style } : undefined));
    // short words: like the words either side when those agree, else like the line
    const out = judged.map((v, i) => {
      if (v) return v;
      let j = i - 1;
      while (j >= 0 && !judged[j]) j--;
      let k = i + 1;
      while (k < judged.length && !judged[k]) k++;
      const a = judged[j];
      const b = judged[k];
      return a && b && same(a, b) ? a : a && !b ? a : b && !a ? b : line;
    });
    return out.map((v) => (v.weight === ref.weight && v.style === ref.style ? null : v));
  }
  const CATALOGW = (id) => (NpFonts.CATALOG[id] && NpFonts.CATALOG[id][2]) || [400, 700];

  async function convertPage(info) {
    if (!info.page || isConv(info.entry.uid)) return 0;
    // A check box or other mark at the start or end of a line is often read
    // as a bracket and a character ("[1"): left as scanned, the line without it.
    const mark = (w) => w.t.replace(/[^\p{L}\p{N}]/gu, '').length <= 1 && /[^\p{L}\p{N}\s.,:;'"’!?-]/u.test(w.t) && (w.c == null ? 100 : w.c) < 85;
    const trim = (t) => {
      const ws = t.words.slice();
      while (ws.length > 1 && mark(ws[0])) ws.shift();
      while (ws.length > 1 && mark(ws[ws.length - 1])) ws.pop();
      return ws.length === t.words.length ? t : Object.assign({}, t, { words: ws, x: ws[0].x0, w: ws[ws.length - 1].x1 - ws[0].x0, str: ws.map((w) => w.t).join(' ') });
    };
    const all = (await textItems(info)).filter((t) => t.scan && t.words && t.words.length).map(trim);
    const phrases = all.filter((t) => convertible(t.words));
    // what is not converted is left as scanned: handwriting, mostly, which
    // can be erased to clear a filled-in form
    const left = all.filter((t) => !phrases.includes(t) && t.words.some((w) => /[\p{L}\p{N}]/u.test(w.t)));
    // Bold is judged against the page's own strokes: a black-and-white scan
    // thickens every letter, so a fixed measure would call it all bold.
    const sws = phrases.flatMap((t) => t.words.map((w) => w.sw)).filter((v) => v > 0).sort((a, b) => a - b);
    S.boldCut = Math.max(S.boldStroke, sws.length ? sws[sws.length >> 1] * 1.22 : 0);
    if (!phrases.length) return 0;
    // one fresh render at 300 dpi, for colors and for comparing letters with fonts
    const K = Math.min(300 / 72, 3400 / Math.max(info.w, info.h));
    const c = document.createElement('canvas');
    c.width = Math.round(info.w * K);
    c.height = Math.round(info.h * K);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = paperOf(info);
    g.fillRect(0, 0, c.width, c.height);
    await info.page.render(renderOpts(info, g, K)).promise;
    const view = { canvas: c, w: info.w };
    const samplesOf = (ws, n) => ws.filter((w) => w.t.replace(/[^\p{L}\p{N}]/gu, '').length >= 2).slice(0, n).map((w) => ({
      text: w.t, canvas: c,
      x: Math.max(0, Math.floor(w.x0 * K) - 1), y: Math.max(0, Math.floor(w.y0 * K) - 1),
      w: Math.ceil((w.x1 - w.x0) * K) + 2, h: Math.ceil((w.y1 - w.y0) * K) + 2
    })).filter((q) => q.w > 2 && q.h > 2 && q.x + q.w <= c.width && q.y + q.h <= c.height);
    const list = phrases.map((t) => {
      const ws = t.words;
      const y0 = Math.min(...ws.map((w) => w.y0));
      const ink = sampleInk(view, { x: ws[0].x0, y: y0, w: ws[ws.length - 1].x1 - ws[0].x0, h: Math.max(...ws.map((w) => w.y1)) - y0 });
      const sw = median(ws.map((w) => w.sw));
      return { t, ink, bold: sw != null ? sw > S.boldCut : ink.density > 0.3, n: ws.length };
    });
    // small caps: OCR reads them as capitals, so the letters are measured
    const cd = g.getImageData(0, 0, c.width, c.height).data;
    for (const q of list) {
      const sc = smallCapsOf(q.t.words, cd, c.width, c.height, K, q.ink.bg);
      if (sc) { q.caps = sc.ratio; q.t = Object.assign({}, q.t, { words: sc.words }); }
    }
    api.status(_('Matching the fonts…'), 'pending');
    const out = [];
    const rgb = (hex) => [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16));
    for (const bold of [false, true]) {
      const mine = list.filter((q) => q.bold === bold);
      if (!mine.length) continue;
      let main = null;
      const plain = mine.filter((q) => !q.caps);
      try { main = await styleFont((plain.length ? plain : mine).map((q) => q.t.words), bold, samplesOf); } catch (e) { main = null; }
      // Without the page's font (offline, say) a redrawn line would look
      // nothing like the original: leave these lines as scanned.
      if (!main) { S.convNoFont = true; continue; }
      // A line set in another typeface (a serif note on a sans form, say):
      // one that fits the page's font clearly worse than the rest gets the
      // font that fits it, found among the fonts already matched or anew.
      if (main && NpFonts.score) {
        // judged on plain words: a misread mark ("*" read as "™") draws
        // nothing like what is on the page and would make print look like writing
        const plainWord = (w) => /^[\p{L}\p{N}.,:;'’"()\/-]+$/u.test(w.t) && /[\p{L}\p{N}]{2}/u.test(w.t);
        for (const q of mine) {
          q.samp = samplesOf(q.t.words.filter(plainWord), 6);
          q.sc = q.samp.length ? await NpFonts.score(q.samp, main) : null;
        }
        // how well the page's font fits its lines, from lines with enough words to say
        const typical = median(mine.filter((q) => q.samp.length >= 4).map((q) => q.sc)) ?? median(mine.map((q) => q.sc));
        const known = [main];
        let looked = 0;
        for (const q of mine) {
          if (q.sc == null || typical == null || q.sc >= typical - 0.08 || q.samp.length < 4) continue;
          let best = null;
          for (const f of known.slice(1)) {
            const sc = await NpFonts.score(q.samp, f);
            if (sc != null && (!best || sc > best.sc)) best = { f, sc };
          }
          if (best && best.sc >= typical - 0.08) { q.ref = best.f; continue; }
          if (looked >= 6) continue;
          looked++;
          let r = null;
          try { r = await NpFonts.identify(q.samp, { bold }); } catch (e) { r = null; }
          // taken when it fits this line about as well as the page's font fits the rest
          if (r && r.score > q.sc + 0.04 && r.score >= typical - 0.06) { await NpFonts.load(r); known.push(r); q.ref = r; }
        }
        // Writing by hand fits no font: a line whose letters match nothing
        // found on the page (nor its italic) is left as it was scanned,
        // rather than have its letters half erased and typed over.
        for (const q of mine) {
          // small caps read as capitals look nothing like the capitals drawn for them
          if (q.ref || q.caps || q.sc == null || typical == null || q.sc >= typical - 0.15) continue;
          let best = q.sc;
          for (const f of known.slice(1).concat([{ id: main.id, weight: main.weight, style: 'italic' }])) {
            const sc = await NpFonts.score(q.samp, f);
            if (sc != null) best = Math.max(best, sc);
          }
          // read surely, a loose fit is print in a font not on the list; only a
          // poor fit, or a loose one read unsurely, is left as it was scanned
          const cs = q.t.words.map((w) => w.c).filter((c) => c != null);
          const conf = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 100;
          if (best < typical - 0.2 || (best < typical - 0.15 && conf < 90)) { q.skip = true; q.fit = best - typical; }
        }
      }
      for (let i = mine.length - 1; i >= 0; i--) if (mine[i].skip) { left.push(Object.assign({}, mine[i].t, { fit: mine[i].fit })); mine.splice(i, 1); }
      const byFont = new Map();
      for (const q of mine) {
        const ref = q.ref || main;
        const k2 = ref ? ref.id + ':' + ref.weight + ':' + ref.style : '';
        if (!byFont.has(k2)) byFont.set(k2, { ref, qs: [] });
        byFont.get(k2).qs.push(q);
      }
      // one ink color for the page's text, unless a phrase is clearly another color
      const fgs = mine.map((q) => rgb(q.ink.fg));
      const common = [0, 1, 2].map((ch) => median(fgs.map((v) => v[ch])));
      const commonHex = '#' + common.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
      for (const { ref, qs } of byFont.values()) {
        const cat = ref && NpFonts.CATALOG[ref.id] ? NpFonts.CATALOG[ref.id][1] : 'sans';
        const family = cat === 'mono' ? 'mono' : cat === 'serif' ? 'serif' : 'sans';
        const style = ref ? { family, font: { id: ref.id, weight: ref.weight, style: ref.style }, bold: ref.weight >= 600, italic: ref.style === 'italic' } : { family: 'sans', bold, italic: false };
        for (const q of qs) {
          if (q.caps) {
            // sized by the full capitals that start its words
            const r = q.t.words.filter((w) => /^\p{Lu}/u.test(w.t)).map((w) => (w.y1 - w.y0) / inkOf(w.t[0], Object.assign({}, style, { size: 1 })).h).filter((v) => v > 0 && isFinite(v));
            q.size = Math.round((median(r) || q.t.size) * 10) / 10;
            continue;
          }
          // from the printed letters' own height (OCR's line height counts
          // writing on the same line)
          const h = sizeFromInk(q.t.words, style, q.t.size);
          q.size = clamp(fitSize(q.t.words, style, h), h * 0.88, h * 1.14);
        }
        clusterSizes(qs);
        if (ref) for (const q of qs) if (!q.caps) q.vs = await wordStyles(q.t.words, ref, samplesOf);
        for (const q of qs) {
          const ws = q.t.words;
          const v = rgb(q.ink.fg);
          const near = Math.abs(v[0] - common[0]) + Math.abs(v[1] - common[1]) + Math.abs(v[2] - common[2]) < 90;
          const it = Object.assign({
            id: uid(), type: 'text', page: info.entry.uid, origKey: q.t.key, conv: true,
            words: ws.map((w, i) => (q.vs && q.vs[i] ? Object.assign({}, w, { v: q.vs[i] }) : w)), origText: ws.map((w) => w.t).join(' '), text: ws.map((w) => w.t).join(' '),
            base: inkBase(ws, q.t.base), size: q.size, smallCaps: q.caps || undefined, heightSize: q.t.size, color: near ? commonHex : q.ink.fg, bg: q.ink.bg,
            limit: await lineLimit(info, q.t, ws)
          }, JSON.parse(JSON.stringify(style)));
          it.x = ws[0].x0 - inkOf(ws[0].t, it).lsb;
          it.y = it.base - BASELINE[it.family] * it.size;
          out.push(it);
        }
      }
    }
    if (S.rec.items.some((i) => i.page === info.entry.uid && i.conv)) return 0;
    try { await buildScanFonts(out, c, K); } catch (e) { /* the matched fonts are used as they are */ }
    groupParagraphs(out);
    S.rec.items.push(...out);
    return out.length;
  }

  async function convertCurrent() {
    const info = currentPage();
    if (!info || !S.rec) return;
    if (isConv(info.entry.uid)) { api.toast(_('This page’s text is already editable. Click a line with Edit text to change it.')); return; }
    const ocr = S.rec.ocr && S.rec.ocr[info.entry.uid];
    if (!ocrFits(ocr, info.entry, info.rot)) { await clickRead(info, -1, -1); return; }
    const before = snap();
    let n = 0;
    S.convNoFont = false;
    try { n = await convertPage(info); } finally { api.saved(); }
    if (!n) { api.toast(S.convNoFont ? _('The fonts needed to redraw this page could not be downloaded. Check your connection and try again.') : _('No text on this page was read clearly enough to make editable.')); return; }
    commit(before);
    setTool('edit');
    renderOverlay(info);
    api.toast(_('The text on this page is now editable. Click any line to change it.'), 5000);
  }

  // Back to the scan as it was; Edit text then patches single words instead.
  function unconvertCurrent() {
    const info = currentPage();
    if (!info || !isConv(info.entry.uid)) { api.toast(_('This page is shown as it was scanned already.')); return; }
    const before = snap();
    S.rec.items = S.rec.items.filter((i) => !(i.page === info.entry.uid && (i.conv || i.type === 'hand')));
    S.sel = null;
    commit(before);
    renderOverlay(info);
    renderStyleBar();
    api.toast(_('This page is back to the original scan. Edit text now changes single words and leaves the rest of the scan as it is.'), 7000);
  }

  async function setHand(list, erased, before0) {
    if (!list.length) return;
    const before = before0 || snap();
    if (erased) {
      api.status(_('Finding the pen strokes…'), 'pending');
      for (const it of list) {
        const info = S.info.get(it.page);
        if (!it.parts && info && info.page) { try { it.parts = await handParts(info, it); } catch (e) { it.parts = null; } }
      }
      api.saved();
    }
    for (const it of list) it.erased = erased;
    commit(before);
    for (const uidv of new Set(list.map((i) => i.page))) renderOverlay(S.info.get(uidv));
    renderStyleBar();
  }

  // Proofreading: the page as scanned, with the text drawn from it hidden.
  function toggleOriginal(on) {
    if (S.fix) closeFix(true);
    S.showOriginal = on === undefined ? !S.showOriginal : !!on;
    document.body.classList.toggle('pdf-show-original', S.showOriginal);
    if (S.editing) finishEditing();
    for (const info of S.info.values()) if (isConv(info.entry.uid)) renderPage(info);
    if (S.rec) renderAllOverlays();
    updateConvUi();
  }

  function updateConvUi() {
    const any = !!S.rec && S.rec.items.some((i) => i.conv);
    const b = $('#pdf-toolbar [data-pdf="original"]');
    if (b) {
      b.hidden = !any;
      b.classList.toggle('on', !!S.showOriginal);
      b.setAttribute('aria-pressed', S.showOriginal ? 'true' : 'false');
    }
    if (!any && S.showOriginal) { S.showOriginal = false; document.body.classList.remove('pdf-show-original'); }
  }

  // Words OCR was less than sure of: marked, so they are easy to check.
  const doubtful = (w) => w.c != null && w.c < 90;

  /* ----- correcting what OCR read ----- */

  // A small box under a word: the word as scanned, enlarged, over what OCR
  // read, to correct. The correction is what the page says, not an edit: the
  // word is redrawn where it was, and search and copy use it.
  // What a fix box is about: the word's box on the page, what OCR read, and
  // how to put the correction in. A word of a line drawn as text (item:word),
  // or one of a line left as scanned (ocr:line:word), which only the hidden,
  // searchable text carries.
  function fixTarget(info, ref) {
    const parts = ref.split(':');
    if (parts[0] === 'ocr') {
      const ocr = S.rec.ocr && S.rec.ocr[info.entry.uid];
      const l = ocr && ocr.lines[+parts[1]];
      const w = l && l.words && l.words[+parts[2]];
      if (!w) return null;
      return {
        box: { x0: w.x, x1: w.x + w.w, y0: w.y, y1: w.y + w.h }, t: w.t,
        apply: (val) => {
          if (val) { w.t = val; w.c = 100; } else l.words.splice(l.words.indexOf(w), 1);
          l.text = l.words.map((q) => q.t).join(' ');
          info.text = null;
          changed();
          textItems(info).then(() => renderOverlay(info));
        }
      };
    }
    const it = itemById(parts[0]);
    const w = it && it.words[+parts[1]];
    if (!w) return null;
    return { box: w, t: w.t, it, w, apply: (val) => fixWord(it, w, val) };
  }

  async function openFix(info, ref) {
    closeFix(false);
    const tg = fixTarget(info, ref);
    if (!tg) return;
    const w = tg.box;
    const k = 4;
    const pad = 3;
    const cv = el('canvas', { class: 'pdf-fix-scan' });
    cv.width = Math.ceil((w.x1 - w.x0 + pad * 2) * k);
    cv.height = Math.ceil((w.y1 - w.y0 + pad * 2) * k);
    const input = el('input', { type: 'text', class: 'pdf-fix-input', value: tg.t, 'aria-label': _('What this word says'), spellcheck: 'true' });
    const box = el('div', { class: 'pdf-fix', role: 'dialog', 'aria-label': _('Correct this word') },
      el('div', { class: 'pdf-fix-label' }, _('Scanned word')), cv,
      el('div', { class: 'pdf-fix-label' }, ref.startsWith('ocr:') ? _('OCR read it as (used only to search and copy; the page shows it as written)') : _('It says')), input,
      el('div', { class: 'pdf-fix-hint' }, (tg.w && doubtful(tg.w) ? _('OCR was unsure of this word.') + ' ' : '') + _('Enter saves · Tab goes to the next word to check · Esc cancels')),
      tg.it ? el('button', { type: 'button', class: 'btn btn-sm pdf-fix-edit' }, _('Edit the whole line instead')) : null);
    info.el.append(box);
    S.fix = { info, tg, box };
    const editBtn = box.querySelector('.pdf-fix-edit');
    if (editBtn) {
      editBtn.addEventListener('mousedown', (e) => e.preventDefault());
      editBtn.addEventListener('click', () => { closeFix(false); setTool('edit'); startEditing(tg.it.id); });
    }
    placeFix();
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); closeFix(true); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFix(false); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const next = nextDoubt(tg.w, e.shiftKey);
        closeFix(true);
        // found by the word itself: saving may have split this one into two
        const k2 = next ? next.it.words.indexOf(next.w) : -1;
        if (k2 >= 0) openFix(next.info, next.it.id + ':' + k2);
      }
    });
    // focus moving to something else on the page saves; switching to another window does not
    input.addEventListener('blur', (e) => { if (e.relatedTarget && !box.contains(e.relatedTarget) && S.fix && S.fix.box === box) closeFix(true); });
    input.focus();
    input.select();
    box.scrollIntoView({ block: 'nearest' });
    try {
      const g = cv.getContext('2d');
      g.fillStyle = paperOf(info);
      g.fillRect(0, 0, cv.width, cv.height);
      await info.page.render(renderOpts(info, g, k, -(w.x0 - pad) * k, -(w.y0 - pad) * k)).promise;
    } catch (e) { /* the box works without the picture */ }
  }

  // The right-click menu on a word read from a scan: the word as scanned,
  // what OCR read, a way to correct it, and the usual editing commands.
  function closeWordMenu() {
    const m = document.querySelector('.pdf-word-menu');
    if (m) m.remove();
    document.removeEventListener('pointerdown', S.menuAway, true);
    document.removeEventListener('keydown', S.menuKey, true);
    window.removeEventListener('blur', closeWordMenu);
  }

  function openWordMenu(e, info, ref) {
    closeWordMenu();
    closeFix(true);
    const tg = fixTarget(info, ref);
    if (!tg) return;
    const w = tg.box;
    const lineText = tg.it ? convLayout(tg.it).map((r) => r.text).join(' ') : tg.t;
    const item = (label, fn, hint) => {
      const b = el('button', { type: 'button', role: 'menuitem', class: 'pdf-menu-item' }, el('span', {}, label), hint ? el('span', { class: 'pdf-menu-hint' }, hint) : null);
      b.addEventListener('click', () => { closeWordMenu(); fn(); });
      return b;
    };
    const copy = async (text) => { try { await navigator.clipboard.writeText(text); } catch (err) { api.toast(_('Your browser blocked copying.')); } };
    const cv = el('canvas', { class: 'pdf-menu-scan' });
    const k = 3;
    const pad = 2;
    cv.width = Math.ceil((w.x1 - w.x0 + pad * 2) * k);
    cv.height = Math.ceil((w.y1 - w.y0 + pad * 2) * k);
    const doubt = tg.w && doubtful(tg.w);
    const menu = el('div', { class: 'pdf-word-menu', role: 'menu' },
      el('div', { class: 'pdf-menu-head' }, cv, el('div', { class: 'pdf-menu-read' }, doubt ? _('Possibly misread as “{word}”', { word: tg.t }) : _('Read as “{word}”', { word: tg.t }))),
      item(doubt ? _('Check and correct this word…') : _('Correct this word…'), () => openFix(info, ref)),
      el('div', { class: 'pdf-menu-sep' }),
      tg.it ? item(_('Edit text'), () => { setTool('edit'); startEditing(tg.it.id); }) : null,
      item(_('Copy word'), () => copy(tg.t)),
      tg.it ? item(_('Copy line'), () => copy(lineText)) : null,
      item(_('Copy page text'), () => copyPageText()));
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4)) + 'px';
    S.menuAway = (ev) => { if (!menu.contains(ev.target)) closeWordMenu(); };
    S.menuKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); closeWordMenu(); return; }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const items = [...menu.querySelectorAll('.pdf-menu-item')];
        const i = items.indexOf(document.activeElement);
        items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    document.addEventListener('pointerdown', S.menuAway, true);
    document.addEventListener('keydown', S.menuKey, true);
    window.addEventListener('blur', closeWordMenu);
    menu.querySelector('.pdf-menu-item').focus();
    const g = cv.getContext('2d');
    g.fillStyle = paperOf(info);
    g.fillRect(0, 0, cv.width, cv.height);
    info.page.render(renderOpts(info, g, k, -(w.x0 - pad) * k, -(w.y0 - pad) * k)).promise.catch(() => {});
  }

  // under its word, at the current zoom (the page can be re-fitted while the
  // box is open, as when a phone's keyboard opens)
  function placeFix() {
    const f = S.fix;
    const w = f && f.tg.box;
    if (!w) return;
    f.box.style.left = Math.max(0, Math.min(f.info.w * S.scale - 244, w.x0 * S.scale)) + 'px';
    f.box.style.top = (w.y1 + 6) * S.scale + 'px';
  }

  function closeFix(save) {
    const f = S.fix;
    if (!f) return;
    S.fix = null;
    f.box.remove();
    if (!save) return;
    const val = f.box.querySelector('input').value.replace(/\s+/g, ' ').trim();
    if (val === f.tg.t) return;
    f.tg.apply(val);
    renderOverlay(f.info);
    renderStyleBar();
  }

  function fixWord(it, w, val) {
    const before = snap();
    // the line as it now reads, word by word, with this word in it
    const lay = convLayout(it);
    const at = lay.findIndex((r) => r.o === w);
    const neu = lay.map((r) => r.text);
    if (!val) {
      // nothing there (OCR read a speck as a word): the word just goes
      if (at >= 0) neu.splice(at, 1);
      it.text = neu.join(' ');
    } else {
      // one box per word typed, sharing the old box by letters
      const parts = val.split(' ');
      const total = parts.reduce((t, q) => t + q.length, 0) + (parts.length - 1) * 0.6;
      let x = w.x0;
      const boxes = parts.map((q) => {
        const wd = ((w.x1 - w.x0) * q.length) / total;
        const b = Object.assign({}, w, { t: q, x0: x, x1: x + wd, c: 100 });
        x += wd + ((w.x1 - w.x0) * 0.6) / total;
        return b;
      });
      // a new array: undo snapshots share the old one
      const k = it.words.indexOf(w);
      it.words = it.words.slice(0, k).concat(boxes, it.words.slice(k + 1));
      if (at >= 0) neu.splice(at, 1, ...parts);
      it.text = neu.join(' ');
    }
    it.origText = it.words.map((q) => q.t).join(' ');
    commit(before);
  }

  // The next word to check after this one, in reading order across the pages.
  function nextDoubt(cur, back) {
    const list = [];
    for (const inf of S.info.values()) {
      const items = S.rec.items.filter((i) => i.page === inf.entry.uid && i.conv).sort((a, b) => (Math.abs(a.base - b.base) < a.size * 0.5 ? a.x - b.x : a.base - b.base));
      for (const i of items) for (const w of i.words) if (doubtful(w) || w === cur) list.push({ info: inf, it: i, w, me: w === cur });
    }
    const pos = list.findIndex((q) => q.me);
    const rest = list.filter((q) => !q.me);
    if (!rest.length) return null;
    const n = back ? (pos - 1 + list.length) % list.length : (pos + 1) % list.length;
    const q = list[n];
    return q && !q.me ? q : rest[0];
  }

  // The words of a converted line, placed: unchanged words where they were
  // on the scan (so columns stay lined up), changed words set naturally
  // after the ones before them, and the line narrowed a little if it would
  // run past its cell. Every word is redrawn, so a line looks of a piece;
  // words OCR was unsure of are marked to check instead.
  function convLayout(it) {
    const orig = it.words;
    const neu = it.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!neu.length) return [];
    let p = 0;
    while (p < orig.length && p < neu.length && orig[p].t === neu[p]) p++;
    let s = 0;
    while (s < orig.length - p && s < neu.length - p && orig[orig.length - 1 - s].t === neu[neu.length - 1 - s]) s++;
    const gaps = orig.slice(1).map((w, k) => w.x0 - orig[k].x1).filter((v) => v > 0).sort((a, b) => a - b);
    const gap = gaps.length ? gaps[gaps.length >> 1] : textWidth(' ', it);
    const runs = [];
    let end = null;
    // new words take the look of the word they replace (or the one before
    // them), or the look they had before a paragraph was rewrapped (tv), and
    // the line's narrowing
    const vNew = (orig[Math.min(p, orig.length - 1)] || {}).v;
    const fitNew = p < neu.length ? lineFit(it) : 1;
    neu.forEach((t, i) => {
      const o = i < p ? orig[i] : i >= neu.length - s ? orig[orig.length - (neu.length - i)] : null;
      const v = o ? o.v : it.tv && it.tv[i] !== undefined ? it.tv[i] : vNew;
      const ink = measureRun(t, runStyle(it, v), it.smallCaps);
      const flow = end == null ? lineStart(it) : end + gap;
      // words before the change stay put; from the change on the line flows
      // like ordinary text
      const x0 = i < p ? o.x0 : flow;
      // an unchanged word never grows past the room it had on the page
      // an unchanged word fills exactly the room it had on the page (within reason)
      const sx = o ? clamp((o.x1 - o.x0) / (ink.w || 1), 0.85, 1.12) : fitNew;
      runs.push({ text: t, x0, w: ink.w * sx, lsb: ink.lsb, sx, o, v });
      end = x0 + ink.w * sx;
    });
    let scaleX = 1;
    let overflow = false;
    const lastX1 = orig.length ? orig[orig.length - 1].x1 : lineStart(it);
    const limit = it.limit != null ? Math.max(it.limit, lastX1) : lastX1 + it.size * 0.2;
    if (end > limit + 0.5 && p < runs.length) {
      const from = runs[p].x0;
      const f = Math.max(0.8, (limit - from) / (end - from));
      overflow = from + (end - from) * f > limit + it.size * 0.1;
      scaleX = f;
      for (let i = p; i < runs.length; i++) { runs[i].x0 = from + (runs[i].x0 - from) * f; runs[i].w *= f; runs[i].sx *= f; }
    }
    return runs.map((r) => ({ text: r.text, x: r.x0 - r.lsb * r.sx, base: it.base, scaleX: r.sx, overflow, o: r.o, v: r.v, st: runStyle(it, r.v) }));
  }

  /* ----- the scan's own letters ----- */

  // The letters of the words OCR read surely, cut from a render of the page
  // (k pixels per point), by the font each is drawn in: the ink of a word
  // split into pieces, joined where one stands over another (the dot of an
  // i, an accent), and kept only when there is one piece per letter.
  function letterSamples(items, c, k) {
    const g = c.getContext('2d', { willReadFrequently: true });
    const out = {}; // font key → { char → [sample] }
    for (const it of items) {
      if (!it.font || it.smallCaps) continue;
      const bgRgb = [1, 3, 5].map((q) => parseInt((it.bg || '#ffffff').slice(q, q + 2), 16));
      const fgRgb = [1, 3, 5].map((q) => parseInt((it.color || '#000000').slice(q, q + 2), 16));
      const bgL = bgRgb[0] * 0.299 + bgRgb[1] * 0.587 + bgRgb[2] * 0.114;
      const fgL = fgRgb[0] * 0.299 + fgRgb[1] * 0.587 + fgRgb[2] * 0.114;
      if (bgL - fgL < 60) continue;
      for (const w of it.words) {
        const chars = [...w.t];
        if (w.c != null && w.c < 90) continue;
        // one-letter words are left out: a bar or a speck read as "I" or "l"
        // would teach the font the wrong shape
        if (chars.length > 24 || chars.length < 2) continue;
        const pad = 2;
        const X0 = Math.max(0, Math.floor(w.x0 * k) - pad);
        const Y0 = Math.max(0, Math.floor((Math.min(w.y0, it.base - it.size)) * k) - pad);
        const X1 = Math.min(c.width, Math.ceil(w.x1 * k) + pad);
        const Y1 = Math.min(c.height, Math.ceil(Math.max(w.y1, it.base + it.size * 0.3) * k) + pad);
        const W = X1 - X0;
        const H = Y1 - Y0;
        if (W < 4 || H < 4) continue;
        const d = g.getImageData(X0, Y0, W, H).data;
        const ink = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) ink[i] = clamp((bgL - (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114)) / (bgL - fgL), 0, 1);
        // the pieces, by flood fill over clearly-ink pixels
        const lab = new Int32Array(W * H).fill(-1);
        const boxes = [];
        for (let s0 = 0; s0 < W * H; s0++) {
          if (ink[s0] < 0.5 || lab[s0] >= 0) continue;
          const id = boxes.length;
          const b = { x0: W, x1: 0, y0: H, y1: 0, n: 0, ids: [id] };
          const st = [s0];
          lab[s0] = id;
          while (st.length) {
            const i = st.pop();
            const x = i % W;
            const y = (i / W) | 0;
            b.n++;
            if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const j = ny * W + nx;
              if (ink[j] >= 0.5 && lab[j] < 0) { lab[j] = id; st.push(j); }
            }
          }
          boxes.push(b);
        }
        // specks are no letter; pieces one above the other are one letter
        let parts = boxes.filter((b) => b.n >= 3);
        parts.sort((a, b) => a.x0 - b.x0);
        const merged = [];
        for (const b of parts) {
          const m = merged.find((q) => Math.min(q.x1, b.x1) - Math.max(q.x0, b.x0) >= Math.min(q.x1 - q.x0, b.x1 - b.x0) * 0.6);
          if (m) { m.x0 = Math.min(m.x0, b.x0); m.x1 = Math.max(m.x1, b.x1); m.y0 = Math.min(m.y0, b.y0); m.y1 = Math.max(m.y1, b.y1); m.ids.push(...b.ids); }
          else merged.push(Object.assign({}, b, { ids: b.ids.slice() }));
        }
        merged.sort((a, b) => a.x0 - b.x0);
        // the word's box may hold a neighbor's edge: only pieces inside the word count
        const inside = merged.filter((b) => (b.x0 + b.x1) / 2 + X0 >= w.x0 * k - 1 && (b.x0 + b.x1) / 2 + X0 <= w.x1 * k + 1);
        if (inside.length !== chars.length) continue;
        const key = NpFonts.keyOf(runStyle(it, w.v).font);
        const per = out[key] || (out[key] = {});
        inside.forEach((b, i) => {
          const ch = chars[i];
          const mine = new Set(b.ids);
          const x0 = Math.max(0, b.x0 - 1);
          const y0 = Math.max(0, b.y0 - 1);
          const x1 = Math.min(W - 1, b.x1 + 1);
          const y1 = Math.min(H - 1, b.y1 + 1);
          const sw = x1 - x0 + 1;
          const sh = y1 - y0 + 1;
          const s = new Float32Array(sw * sh);
          for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
              const i2 = y * W + x;
              let near = mine.has(lab[i2]);
              // the soft edge: faint pixels next to this letter's ink, and no other's
              if (!near && lab[i2] < 0) {
                for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) {
                  const nx = x + dx;
                  const ny = y + dy;
                  if (nx >= 0 && ny >= 0 && nx < W && ny < H && mine.has(lab[ny * W + nx])) near = true;
                }
              }
              if (near) s[(y - y0) * sw + (x - x0)] = ink[i2];
            }
          }
          (per[ch] || (per[ch] = [])).push({ ink: s, w: sw, h: sh, base: it.base * k - (Y0 + y0), em: it.size * k });
        });
      }
    }
    return out;
  }

  let scanFontLib = null;
  async function buildScanFonts(items, c, k) {
    if (typeof NpFonts === 'undefined' || S.rec.scanFontsOff) return;
    const rec = S.rec;
    const all = letterSamples(items, c, k);
    rec.scanFonts = rec.scanFonts || {};
    const todo = Object.entries(all).filter(([key, per]) => !rec.scanFonts[key] && Object.values(per).some((l) => l.length >= 2));
    if (!todo.length) return;
    if (!scanFontLib) scanFontLib = Promise.all([loadScript(VENDOR + 'opentype/opentype.min.js'), loadScript('js/scanfont.js')]);
    await scanFontLib;
    api.status(_('Making fonts from the scan’s letters…'), 'pending');
    for (const [key, per] of todo) {
      const [id, weight, style] = key.split(':');
      try {
        const base = await NpFonts.baseBytes({ id, weight: +weight, style });
        const r = NpScanFont.build(base, per, 'Noteshack Scan ' + (Object.keys(rec.scanFonts).length + 1));
        if (r) rec.scanFonts[key] = r.bytes;
      } catch (e) { /* this style keeps its matched font */ }
      await new Promise((res) => setTimeout(res, 0));
    }
    useScanFonts();
    await Promise.all(items.flatMap(itemFonts).map((f) => NpFonts.load(f).catch(() => null)));
  }

  // The scan's letters stand in for the matched fonts (unless turned off).
  function useScanFonts() {
    if (typeof NpFonts === 'undefined' || !S.rec) return;
    NpFonts.setCustom(S.rec.scanFontsOff ? {} : S.rec.scanFonts || {});
  }

  async function toggleScanFonts() {
    if (!S.rec) return;
    if (!S.rec.scanFonts || !Object.keys(S.rec.scanFonts).length) { api.toast(_('This document has no letters taken from a scan yet. Click a scanned page with Edit text first to read it.'), 5000); return; }
    S.rec.scanFontsOff = !S.rec.scanFontsOff;
    useScanFonts();
    await Promise.all(S.rec.items.flatMap(itemFonts).map((f) => NpFonts.load(f).catch(() => null)));
    renderAllOverlays();
    changed();
    api.toast(S.rec.scanFontsOff ? _('Using the matched fonts as they are.') : _('Using the scan’s own letter shapes.'), 3000);
  }

  // How much narrower the scan's letters are than the matched font's, for a
  // line: its words are fitted to their places on the page by it, and new
  // words take it too, so a line is of a piece (and the editing box can show
  // the line as it will be drawn).
  function lineFit(it) {
    if (!it.words.length) return it.fitX || 1;
    const f = it.words.filter((w) => w.t.replace(/[^\p{L}\p{N}]/gu, '').length >= 2)
      .map((w) => clamp((w.x1 - w.x0) / (measureRun(w.t, runStyle(it, w.v), it.smallCaps).w || 1), 0.85, 1.12));
    return median(f) || 1;
  }

  // The box a converted line (or its whole paragraph) is edited in, set as
  // the line is drawn: the same fonts word by word, the same narrowing, the
  // scan's word spacing, and for a paragraph its width and line spacing, so
  // what is typed looks as it will once done, and wraps where it will.
  function editorEl(it) {
    const lines = it.para ? paraLines(it.para) : [it];
    const top = lines[0];
    const g = it.para ? paraGeom(lines) : null;
    const f = median(lines.map(lineFit)) || 1;
    const gaps = [];
    for (const l of lines) for (let k = 1; k < l.words.length; k++) { const gp = l.words[k].x0 - l.words[k - 1].x1; if (gp > 0) gaps.push(gp); }
    const gap = median(gaps);
    const space = textWidth(' ', top);
    const lay0 = convLayout(top);
    const x = g ? g.left : lay0[0] ? lay0[0].x : lineStart(top);
    const lineH = g ? g.pitch : top.size * LINE;
    const weight = (st) => (st.font ? st.font.weight : st.bold ? 700 : 400);
    const d = el('div', {
      class: 'pdf-item pdf-textbox pdf-edit' + (g ? ' pdf-para' : ''), 'data-id': it.id,
      style: 'left:' + px(x) + ';top:' + px(top.base - BASELINE[top.family] * top.size - (lineH - top.size * LINE) / 2) +
        (g ? ';width:' + px((g.right - g.left) / f + top.size * 0.2) + ';text-indent:' + px((g.first - g.left) / f) : '') +
        ';line-height:' + px(lineH) + ';font-size:' + px(top.size) + ';font-family:' + familyCss(top).replace(/"/g, "'") + ';color:' + top.color +
        ';font-weight:' + weight(top) + ';font-style:' + (top.italic ? 'italic' : 'normal') + (top.smallCaps ? ';font-variant:small-caps' : '') +
        (gap ? ';word-spacing:' + px(gap / f - space) : '') + (Math.abs(f - 1) > 0.002 ? ';transform:scaleX(' + f.toFixed(3) + ');transform-origin:0 0' : '')
    });
    let first = true;
    for (const l of lines) {
      for (const r of convLayout(l)) {
        if (!first) d.append(' ');
        first = false;
        const st = r.st;
        const same = familyCss(st) === familyCss(top) && weight(st) === weight(top) && !!st.italic === !!top.italic && l.color === top.color && Math.abs(l.size - top.size) < 0.05;
        d.append(same ? document.createTextNode(r.text) : el('span', {
          style: 'font-family:' + familyCss(st).replace(/"/g, "'") + ';font-weight:' + weight(st) + ';font-style:' + (st.italic ? 'italic' : 'normal') + ';color:' + l.color +
            (Math.abs(l.size - top.size) >= 0.05 ? ';font-size:' + px(l.size) : '')
        }, r.text));
      }
    }
    return d;
  }

  // Where a converted line starts: its first word on the page, or for a line
  // a rewrapped paragraph added, the paragraph's left edge.
  const lineStart = (it) => (it.words.length ? it.words[0].x0 : it.lineX);
  const lineEnd = (it) => (it.words.length ? it.words[it.words.length - 1].x1 : it.lineX);

  /* ----- paragraphs ----- */

  // Lines that are one paragraph: each just below the last at a steady
  // spacing, in the same column, starting at the same left edge (the first
  // may be indented), in the same font and size, and every line but the
  // last full: the next line's first word would not have fitted on it.
  // A short line ends a paragraph, so form rows stay apart.
  function groupParagraphs(items) {
    const lines = items.filter((i) => i.words.length).sort((a, b) => a.base - b.base || lineStart(a) - lineStart(b));
    const below = new Map();
    for (const a of lines) {
      let best = null;
      for (const b of lines) {
        const dy = b.base - a.base;
        if (b === a || dy < a.size * 0.9 || dy > a.size * 1.9) continue;
        const overlap = Math.min(lineEnd(a), lineEnd(b)) - Math.max(lineStart(a), lineStart(b));
        if (overlap < Math.min(lineEnd(a) - lineStart(a), lineEnd(b) - lineStart(b)) * 0.3) continue;
        if (!best || dy < best.dy - 0.5 || (Math.abs(dy - best.dy) <= 0.5 && Math.abs(lineStart(b) - lineStart(a)) < Math.abs(lineStart(best.b) - lineStart(a)))) best = { b, dy };
      }
      if (best) below.set(a, best.b);
    }
    const taken = new Set();
    for (const a of lines) {
      if (taken.has(a)) continue;
      const group = [a];
      let cur = a;
      let left = null;
      while (below.has(cur)) {
        const b = below.get(cur);

        if (taken.has(b) || group.includes(b)) break;
        if (Math.abs(b.size - cur.size) > cur.size * 0.18 || !!b.smallCaps !== !!cur.smallCaps) break;
        const bx0 = lineStart(b);
        if (left == null ? bx0 > lineStart(cur) + cur.size * 0.8 || bx0 < lineStart(cur) - cur.size * 4 : Math.abs(bx0 - left) > cur.size * 0.8) break;
        if (group.length >= 2 && Math.abs((b.base - cur.base) - (cur.base - group[group.length - 2].base)) > cur.size * 0.25) break;
        const right = Math.max(lineEnd(b), ...group.map(lineEnd));
        const first = b.words[0];
        const need = lineEnd(cur) + textWidth(' ', cur) + (first.x1 - first.x0);
        if (need < right - cur.size * 0.1) break;
        // nor if it had room to spare before its cell border or the margin (a
        // short list item), allowing for a cell's padding
        if (cur.limit != null && need < cur.limit - cur.size * 1.2) break;
        if (left == null) left = bx0;
        group.push(b);
        cur = b;
      }
      for (const l of group) taken.add(l);
      if (group.length >= 2) { const pid = uid(); for (const l of group) l.para = pid; }
    }
  }

  function paraLines(pid) {
    return S.rec.items.filter((i) => i.conv && i.para === pid).sort((a, b) => a.base - b.base);
  }

  // The paragraph's box: its left edge (the lines after the first), the
  // first line's start, its right edge and its line spacing.
  function paraGeom(lines) {
    const rest = lines.length > 1 ? lines.slice(1) : lines;
    const left = Math.min(...rest.map(lineStart));
    const right = Math.max(...lines.map((l) => {
      const lay = convLayout(l);
      const r = lay[lay.length - 1];
      return Math.max(lineEnd(l), r ? r.x + measureRun(r.text, r.st, l.smallCaps).w * r.scaleX : 0);
    }));
    const pitches = lines.slice(1).map((l, k) => l.base - lines[k].base);
    const pitch = median(pitches) || lines[0].size * 1.2;
    return { left, right, first: lineStart(lines[0]), pitch };
  }

  // Styles carried from the old words to the new by matching them up (the
  // longest common run of words); new words take the look of the word before.
  function carryStyles(old, neu) {
    const n = old.length;
    const m = neu.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = old[i].t === neu[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = new Array(m).fill(undefined);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (old[i].t === neu[j]) { out[j] = old[i].v || null; i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
    }
    for (let k = 0; k < m; k++) if (out[k] === undefined) out[k] = k ? out[k - 1] : (old[0] && old[0].v) || null;
    return out;
  }

  // Rewrap a paragraph after an edit, as a word processor would: lines
  // before the change stay as they are, the text flows from just before it
  // until the line breaks fall where they did before, and lines after that
  // stay too. A longer paragraph gets new lines below; a shorter one leaves
  // its last lines empty.
  function reflowPara(pid, text) {
    const lines = paraLines(pid);
    if (!lines.length) return false;
    const g = paraGeom(lines);
    const old = [];
    for (const l of lines) for (const r of convLayout(l)) old.push({ t: r.text, v: r.v });
    const neu = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (neu.join(' ') === old.map((o) => o.t).join(' ')) return false;
    const vs = carryStyles(old, neu);
    const toks = (l) => l.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    // the first line that no longer reads the same
    let li = 0;
    let pos = 0;
    while (li < lines.length) {
      const t = toks(lines[li]);
      if (!t.every((w, k) => neu[pos + k] === w) || (li === lines.length - 1 && pos + t.length !== neu.length)) break;
      pos += t.length;
      li++;
    }
    // from the line before it, so a word added at a line's end can stay there
    let j = Math.max(0, li - 1);
    pos = lines.slice(0, j).reduce((n, l) => n + toks(l).length, 0);
    const placed = [];
    let caughtUp = false;
    let grew = false;
    while (pos < neu.length) {
      if (j > li && j < lines.length && neu.slice(pos).join(' ') === lines.slice(j).map((l) => toks(l).join(' ')).join(' ')) { caughtUp = true; break; }
      const line = lines[j];
      const st = line || lines[lines.length - 1];
      const x = line ? lineStart(line) : g.left;
      // a line keeps at least the room its own words had
      const room = Math.min(Math.max(g.right, line ? x + measureRun(toks(line).join(' '), st, st.smallCaps).w : 0), st.limit != null ? st.limit : Infinity) - x + 0.5;
      // as many words as the line takes when laid out as it will be drawn
      // (its unchanged words stay where they were), without narrowing any
      const probe = line || { words: [], lineX: g.left };
      const fits = (k) => {
        const lay = convLayout(Object.assign({}, st, probe, { text: neu.slice(pos, k).join(' '), tv: vs.slice(pos, k), limit: Infinity }));
        const r = lay[lay.length - 1];
        return !r || r.x + measureRun(r.text, r.st, st.smallCaps).w * r.scaleX - x <= room;
      };
      let k = pos + 1;
      while (k < neu.length && fits(k + 1)) k++;
      placed.push({ j, text: neu.slice(pos, k).join(' '), tv: vs.slice(pos, k) });
      pos = k;
      j++;
    }
    for (const q of placed) {
      if (q.j < lines.length) {
        lines[q.j].text = q.text;
        lines[q.j].tv = q.tv;
        continue;
      }
      grew = true;
      const last = lines[lines.length - 1];
      const base = last.base + g.pitch * (q.j - lines.length + 1);
      const it = {
        id: uid(), type: 'text', page: last.page, conv: true, para: pid, words: [], origText: '', text: q.text, tv: q.tv, lineX: g.left, fitX: lineFit(last),
        base, size: last.size, heightSize: last.heightSize, color: last.color, bg: last.bg, limit: last.limit, smallCaps: last.smallCaps,
        family: last.family, font: last.font ? Object.assign({}, last.font) : undefined, bold: last.bold, italic: last.italic
      };
      it.x = g.left;
      it.y = base - BASELINE[it.family || 'sans'] * it.size;
      S.rec.items.push(it);
    }
    // the text ran out before the old lines did: those are left empty
    if (!caughtUp) for (let k = j; k < lines.length; k++) { lines[k].text = ''; lines[k].tv = undefined; }
    if (grew) api.toast('The paragraph needs more lines than it had, so it now runs below where it ended. Check that it does not cover anything; shorten it if it does.', 7000);
    return true;
  }

  // The original words that come off the page: all of them.
  const convErased = (it) => it.words;

  // What cleanCanvas would take off a page, to know when to draw it again.
  function cleanSig(info) {
    if (S.showOriginal || !S.rec) return '';
    return S.rec.items.filter((i) => i.page === info.entry.uid && (i.conv || (i.type === 'hand' && i.erased))).map((i) => i.id + ':' + (i.conv ? convErased(i).length + ':' + (convErased(i)[0] || {}).x0 : 'x' + (i.parts || []).map((q) => (q.keep ? 1 : 0)).join(''))).join('|');
  }

  // What comes off the page for a converted line, in points: one rectangle
  // per run of erased words (the gaps between them included, and a little
  // room either side for ink OCR's boxes missed), and the words left as
  // scanned, which nothing may touch.
  function convRects(it) {
    const gone = new Set(convErased(it));
    const em = it.size;
    const rects = [];
    const keep = [];
    let seg = [];
    const flush = () => {
      if (!seg.length) return;
      const y0 = Math.min(...seg.map((w) => w.y0)) - em * 0.06;
      const y1 = Math.max(...seg.map((w) => w.y1)) + em * 0.06;
      const x0 = seg[0].x0 - em * 0.2;
      const x1 = seg[seg.length - 1].x1 + em * 0.2;
      rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, em });
      seg = [];
    };
    for (const w of it.words) {
      if (gone.has(w)) seg.push(w);
      else { flush(); keep.push({ x: w.x0, y: w.y0, w: w.x1 - w.x0, h: w.y1 - w.y0 }); }
    }
    flush();
    return { rects, keep };
  }

  // Handwriting: the whole of it, and the pieces erased to clear it.
  function handBox(it) {
    const x0 = Math.min(...it.words.map((w) => w.x0));
    const y0 = Math.min(...it.words.map((w) => w.y0));
    const x1 = Math.max(...it.words.map((w) => w.x1));
    const y1 = Math.max(...it.words.map((w) => w.y1));
    const pad = it.area ? 0 : Math.max(1.5, (y1 - y0) * 0.15);
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }
  // The size of the page's printed text: the measure for what counts as a
  // printed line or mark next to handwriting.
  function printedEm(uidv) {
    return median(S.rec.items.filter((i) => i.page === uidv && i.conv).map((i) => i.size)) || 10;
  }
  // What erasing takes off: each pen stroke found in it (or, before those
  // are known, the whole of it), and what it must not touch: the form's own
  // marks among the strokes, like the slashes of a date.
  function handRects(it) {
    if (!it.erased) return { rects: [], keep: [] };
    const em = printedEm(it.page);
    if (!it.parts) {
      const b = handBox(it);
      return { rects: [{ x: b.x, y: b.y, w: b.w, h: b.h, em }], keep: [] };
    }
    const box = (q, pad) => ({ x: q.x0 - pad, y: q.y0 - pad, w: q.x1 - q.x0 + pad * 2, h: q.y1 - q.y0 + pad * 2, em });
    return { rects: it.parts.filter((q) => !q.keep).map((q) => box(q, 0.6)), keep: it.parts.filter((q) => q.keep).map((q) => box(q, 0.2)) };
  }

  // The pieces of ink in a piece of handwriting, each marked to keep or not.
  // Kept: long straight lines (fill-in lines, as long as printed text is
  // tall or longer) and short straight printed marks (a date's slashes, bits
  // of underscore): straight, thin, isolated, and leaning like a printed
  // slash or lying flat. Everything else is the pen.
  async function handParts(info, it) {
    const b = handBox(it);
    const em = printedEm(info.entry.uid);
    // the words of printed text read on the page (made editable, or left as
    // scanned but not writing)
    const handKeys = new Set(S.rec.items.filter((i) => i.type === 'hand').flatMap((i) => i.keys || (i.origKey ? [i.origKey] : [])));
    const printed = [];
    for (const i of S.rec.items) if (i.page === info.entry.uid && i.conv) printed.push(...i.words);
    for (const t of (await textItems(info))) if (t.scan && !handKeys.has(t.key) && !S.rec.items.some((i) => i.conv && i.origKey === t.key)) printed.push(...t.words);
    const K = 300 / 72;
    const m = em * 0.5;
    const x0 = b.x - m;
    const y0 = b.y - m;
    const W = Math.max(1, Math.ceil((b.w + m * 2) * K));
    const H = Math.max(1, Math.ceil((b.h + m * 2) * K));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = paperOf(info);
    g.fillRect(0, 0, W, H);
    await info.page.render(renderOpts(info, g, K, -x0 * K, -y0 * K)).promise;
    const d = g.getImageData(0, 0, W, H).data;
    const lum = (i) => d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    const ls = [];
    for (let i = 0; i < W * H; i += 7) ls.push(lum(i));
    ls.sort((p, q) => p - q);
    const thr = ls[Math.floor(ls.length * 0.6)] - 60;
    const dark = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) dark[i] = lum(i) < thr ? 1 : 0;
    // long lines through the area: part of the form, never erased
    const long = Math.round(em * 1.3 * K);
    const line = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) { if (!dark[y * W + x]) { x++; continue; } let e = x; while (e < W && dark[y * W + e]) e++; if (e - x >= long) for (let q = x; q < e; q++) line[y * W + q] = 1; x = e; }
    }
    for (let x = 0; x < W; x++) {
      let y = 0;
      while (y < H) { if (!dark[y * W + x]) { y++; continue; } let e = y; while (e < H && dark[e * W + x]) e++; if (e - y >= long) for (let q = y; q < e; q++) line[q * W + x] = 1; y = e; }
    }
    // the pieces of ink left: connected strokes
    const minInk = Math.max(6, Math.pow(em * K * 0.07, 2));
    const seen = new Uint8Array(W * H);
    const parts = [];
    const inBox = (px, py) => px / K + x0 > b.x && px / K + x0 < b.x + b.w && py / K + y0 > b.y && py / K + y0 < b.y + b.h;
    for (let start = 0; start < W * H; start++) {
      if (!dark[start] || line[start] || seen[start]) continue;
      const pts = [];
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        pts.push(i);
        const x = i % W;
        const y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (dark[j] && !line[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      let mx = 0;
      let my = 0;
      let bx0 = W;
      let by0 = H;
      let bx1 = 0;
      let by1 = 0;
      for (const i of pts) { const x = i % W; const y = (i / W) | 0; mx += x; my += y; if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; }
      // specks smaller than any pen mark (the dots of a scan's shading) are no part of it
      if (pts.length < minInk) continue;
      // only ink that belongs to this handwriting: a piece mostly outside it is the form's
      if (!inBox((bx0 + bx1) / 2, (by0 + by1) / 2)) continue;
      // nor a letter of printed text the app read there
      const cxp = ((bx0 + bx1) / 2) / K + x0;
      const cyp = ((by0 + by1) / 2) / K + y0;
      if (printed.some((w) => cxp >= w.x0 - 0.5 && cxp <= w.x1 + 0.5 && cyp >= w.y0 - 0.5 && cyp <= w.y1 + 0.5)) continue;
      mx /= pts.length;
      my /= pts.length;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (const i of pts) { const x = i % W - mx; const y = ((i / W) | 0) - my; sxx += x * x; syy += y * y; sxy += x * y; }
      sxx /= pts.length; syy /= pts.length; sxy /= pts.length;
      const tr = sxx + syy;
      const det = sxx * syy - sxy * sxy;
      const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const l2 = Math.max(0, tr - l1);
      const len = Math.sqrt(12 * l1);
      const thick = Math.max(1, pts.length / Math.max(1, len));
      const across = Math.sqrt(l2);
      // the long axis, as degrees from upright (0) to flat (90)
      const ang = Math.abs((Math.atan2(l1 - sxx, sxy || 1e-9) * 180) / Math.PI);
      const fromUp = 90 - Math.min(ang, 180 - ang);
      const emPx = em * K;
      const straight = across <= Math.max(1.2, thick * 0.6);
      const printedMark = straight && thick <= emPx * 0.14 && len >= emPx * 0.45 && len <= emPx * 1.6 &&
        ((fromUp >= 12 && fromUp <= 40) || fromUp >= 80);
      parts.push({ x0: bx0 / K + x0, y0: by0 / K + y0, x1: (bx1 + 1) / K + x0, y1: (by1 + 1) / K + y0, keep: printedMark });
    }
    return parts;
  }

  // Paint the given rectangles (pixels, each with its text's em in pixels)
  // with the paper around them. Any ink shape that crosses a rectangle's
  // edge goes too, so a letter OCR's box cut through is taken whole; long
  // lines (table borders, fill-in lines) stay, and nothing inside skip is
  // touched.
  // Lengths of the straight runs of ink through each pixel of an image whose
  // lines are not level: those that run along y = r + x·tA (lines across the
  // page) and x = c + y·tB (lines down it). A scan that is drawn turned has
  // its borders as staircases in its own pixels; following the slope finds
  // them whole.
  function lineRuns(d, W, H, tA, tB) {
    const lum = (i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const sample = [];
    for (let i = 0; i < W * H; i += 97) sample.push(lum(i * 4));
    sample.sort((a, b) => a - b);
    const thr = sample[Math.floor(sample.length * 0.6)] - 60;
    const dark = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) dark[i] = lum(i * 4) < thr ? 1 : 0;
    const h = new Uint16Array(W * H);
    const v = new Uint16Array(W * H);
    const walk = (n, len, at, out) => {
      // n paths, each len steps; at(path, step) → pixel index or -1
      const run = [];
      for (let r = 0; r < n; r++) {
        for (let k = 0; k <= len; k++) {
          const i = k < len ? at(r, k) : -1;
          if (i >= 0 && dark[i]) { run.push(i); continue; }
          if (run.length) { const l = Math.min(65535, run.length); for (const j of run) out[j] = l; run.length = 0; }
        }
      }
    };
    const offA = Math.ceil(Math.abs(tA) * W) + 1;
    walk(H + offA * 2, W, (r, x) => { const y = Math.round(r - offA + x * tA); return y >= 0 && y < H ? y * W + x : -1; }, h);
    const offB = Math.ceil(Math.abs(tB) * H) + 1;
    walk(W + offB * 2, H, (c, y) => { const x = Math.round(c - offB + y * tB); return x >= 0 && x < W ? y * W + x : -1; }, v);
    return { h, v };
  }

  function inpaint(d, W, H, rects, skip, runs) {
    const lum = (i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const inSkip = (x, y) => skip && skip.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
    for (const r of rects) {
      const x0 = Math.max(0, Math.floor(r.x0));
      const y0 = Math.max(0, Math.floor(r.y0));
      const x1 = Math.min(W, Math.ceil(r.x1));
      const y1 = Math.min(H, Math.ceil(r.y1));
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      const em = Math.max(4, r.em || y1 - y0);
      // the paper: the usual color of a band just outside
      const ring = [];
      const at = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) ring.push((y * W + x) * 4); };
      for (let g = 2; g <= 5; g++) {
        for (let x = x0 - g; x < x1 + g; x++) { at(x, y0 - g); at(x, y1 - 1 + g); }
        for (let y = y0 - g + 1; y < y1 + g - 1; y++) { at(x0 - g, y); at(x1 - 1 + g, y); }
      }
      if (!ring.length) continue;
      const ls = ring.map(lum).sort((a, b) => a - b);
      const mid = ls[ls.length >> 1];
      let n = 0;
      const bg = [0, 0, 0];
      for (const i of ring) if (Math.abs(lum(i) - mid) <= 14) { n++; bg[0] += d[i]; bg[1] += d[i + 1]; bg[2] += d[i + 2]; }
      if (!n) continue;
      bg[0] /= n; bg[1] /= n; bg[2] /= n;
      const bgL = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114;

      const isDark = (x, y) => bgL - lum((y * W + x) * 4) > 60;
      // the area worked on: the rectangle and room around it for shapes that cross its edge
      const wx0 = Math.max(0, x0 - Math.ceil(em * 0.6));
      const wx1 = Math.min(W, x1 + Math.ceil(em * 0.6));
      const wy0 = Math.max(0, y0 - Math.ceil(em * 0.4));
      const wy1 = Math.min(H, y1 + Math.ceil(em * 0.4));
      const ww = wx1 - wx0;
      const wh = wy1 - wy0;
      const idx = (x, y) => (y - wy0) * ww + (x - wx0);
      const dark = new Uint8Array(ww * wh);
      for (let y = wy0; y < wy1; y++) for (let x = wx0; x < wx1; x++) dark[idx(x, y)] = isDark(x, y) ? 1 : 0;
      // a line: a straight run of ink longer than any stroke of a letter
      const long = Math.max(6, Math.round(em * 1.3));
      const prot = new Uint8Array(ww * wh);
      if (runs) {
        for (let y = wy0; y < wy1; y++) for (let x = wx0; x < wx1; x++) {
          const gi = y * W + x;
          if (runs.h[gi] >= long || runs.v[gi] >= long) prot[idx(x, y)] = 1;
        }
      }
      for (let y = wy0; y < wy1 && !runs; y++) {
        let x = wx0;
        while (x < wx1) {
          if (!dark[idx(x, y)]) { x++; continue; }
          let a = x;
          while (a > 0 && x - a < long && (a > wx0 ? dark[idx(a - 1, y)] : isDark(a - 1, y))) a--;
          let b = x;
          while (b < wx1 && dark[idx(b, y)]) b++;
          let e = b;
          while (b === wx1 && e < W && e - a < long && isDark(e, y)) e++;
          if (Math.max(b, e) - a >= long) for (let q = x; q < b; q++) prot[idx(q, y)] = 1;
          x = b;
        }
      }
      for (let x = wx0; x < wx1 && !runs; x++) {
        let y = wy0;
        while (y < wy1) {
          if (!dark[idx(x, y)]) { y++; continue; }
          let a = y;
          while (a > 0 && y - a < long && (a > wy0 ? dark[idx(x, a - 1)] : isDark(x, a - 1))) a--;
          let b = y;
          while (b < wy1 && dark[idx(x, b)]) b++;
          let e = b;
          while (b === wy1 && e < H && e - a < long && isDark(x, e)) e++;
          if (Math.max(b, e) - a >= long) for (let q = y; q < b; q++) prot[idx(x, q)] = 1;
          y = b;
        }
      }
      // Shading in a black-and-white scan is a pattern of dots, and paper has
      // grain: when the band around (less any border line running through
      // it) is not one even color, the hole is filled with pixels taken from
      // it, so the pattern carries on (a flat fill there reads as a white patch).
      const pool = ring.filter((q) => {
        const x = (q >> 2) % W;
        const y = Math.floor((q >> 2) / W);
        return !(x >= wx0 && x < wx1 && y >= wy0 && y < wy1 && prot[idx(x, y)]);
      });
      const even = pool.filter((q) => Math.abs(lum(q) - mid) <= 14).length;
      const textured = pool.length > 20 && even < pool.length * 0.85;
      const src = textured ? pool.map((q) => [d[q], d[q + 1], d[q + 2]]) : null;
      let seed = (x0 * 73856093) ^ (y0 * 19349663);
      const pick = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return src[seed % src.length]; };
      const erase = new Uint8Array(ww * wh);
      const queue = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = idx(x, y);
          if (prot[i]) continue;
          erase[i] = 1;
          if (dark[i] && (x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1)) queue.push(x, y);
        }
      }
      // Ink that carries on past the edge: the rest of the same letter, taken
      // whole. Only if it ends close by: a stroke that runs on (writing that
      // touches the printed word) is something else and stays.
      const reachX = em * 0.3;
      const reachY = em * 0.25;
      while (queue.length) {
        const sy = queue.pop();
        const sx = queue.pop();
        const got = [];
        const st = [[sx, sy]];
        let far = false;
        while (st.length && !far) {
          const [x, y] = st.pop();
          for (let dy = -1; dy <= 1 && !far; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < wx0 || ny < wy0 || nx >= wx1 || ny >= wy1) { far = true; break; }
            const i = idx(nx, ny);
            if (erase[i] || prot[i] || !dark[i]) continue;
            // never along the soft edge of a line that stays, into what it joins
            if ((nx > wx0 && prot[i - 1]) || (nx < wx1 - 1 && prot[i + 1]) || (ny > wy0 && prot[i - ww]) || (ny < wy1 - 1 && prot[i + ww])) continue;
            if (nx < x0 - reachX || nx >= x1 + reachX || ny < y0 - reachY || ny >= y1 + reachY) { far = true; break; }
            erase[i] = 2;
            got.push(i);
            st.push([nx, ny]);
          }
        }
        if (far) for (const i of got) erase[i] = 3; // found to run on: left, and not tried again
      }
      for (let i = 0; i < erase.length; i++) if (erase[i] === 3) erase[i] = 0;
      for (let y = wy0; y < wy1; y++) {
        for (let x = wx0; x < wx1; x++) {
          const i = idx(x, y);
          const p = (y * W + x) * 4;
          if (!erase[i]) {
            // the soft edge of ink that was taken away
            const nb = (x > wx0 && erase[i - 1] === 2) || (x < wx1 - 1 && erase[i + 1] === 2) || (y > wy0 && erase[i - ww] === 2) || (y < wy1 - 1 && erase[i + ww] === 2);
            if (!nb || prot[i] || bgL - lum(p) <= 8) continue;
          } else if (erase[i] === 1 && bgL - lum(p) > 15) {
            // the soft edge of a line that stays
            const nb = (x > wx0 && prot[i - 1]) || (x < wx1 - 1 && prot[i + 1]) || (y > wy0 && prot[i - ww]) || (y < wy1 - 1 && prot[i + ww]);
            if (nb) continue;
          }
          if (inSkip(x, y)) continue;
          if (textured) { const q = pick(); d[p] = q[0]; d[p + 1] = q[1]; d[p + 2] = q[2]; }
          else { d[p] = bg[0]; d[p + 1] = bg[1]; d[p + 2] = bg[2]; }
        }
      }
    }
  }

  // The page on screen without the text that is now drawn as real text.
  function cleanCanvas(info, c) {
    const k = c.width / info.w;
    const rects = [];
    const skip = [];
    const toPx = (b) => ({ x0: b.x * k, y0: b.y * k, x1: (b.x + b.w) * k, y1: (b.y + b.h) * k, em: (b.em || 0) * k });
    for (const it of S.rec.items) {
      if (it.page === info.entry.uid && it.type === 'hand') { const hr = handRects(it); rects.push(...hr.rects.map(toPx)); skip.push(...hr.keep.map(toPx)); }
      if (it.page !== info.entry.uid || !it.conv) continue;
      const cr = convRects(it);
      rects.push(...cr.rects.map(toPx));
      skip.push(...cr.keep.map(toPx));
    }
    if (!rects.length) return;
    const m = Math.ceil(Math.max(...rects.map((r) => r.em)) * 1.5) + 4;
    const bx0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.x0)) - m));
    const by0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.y0)) - m));
    const bx1 = Math.min(c.width, Math.ceil(Math.max(...rects.map((r) => r.x1)) + m));
    const by1 = Math.min(c.height, Math.ceil(Math.max(...rects.map((r) => r.y1)) + m));
    if (bx1 - bx0 < 1 || by1 - by0 < 1) return;
    const sh = (r) => Object.assign({}, r, { x0: r.x0 - bx0, y0: r.y0 - by0, x1: r.x1 - bx0, y1: r.y1 - by0 });
    try {
      const g = c.getContext('2d', { willReadFrequently: true });
      const img = g.getImageData(bx0, by0, bx1 - bx0, by1 - by0);
      inpaint(img.data, img.width, img.height, rects.map(sh), skip.map(sh));
      g.putImageData(img, bx0, by0);
    } catch (e) { /* canvas not readable */ }
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
      const opts = [['sans', _('Sans (Helvetica)')], ['serif', _('Serif (Times)')], ['mono', _('Mono (Courier)')]];
      if (it && it.font) opts.unshift(['matched', NpFonts.label(it.font) + ' (original)']);
      const fam = el('select', { class: 'tb-select', 'aria-label': _('Font'), title: _('Font') },
        opts.map(([v, l]) => el('option', { value: v, selected: v === 'matched' ? true : !(it && it.font) && cur.family === v }, l)));
      fam.addEventListener('change', () => {
        if (fam.value === 'matched') return;
        st.family = fam.value;
        update((i) => { i.family = fam.value; delete i.font; });
      });
      // the item's own size is always listed (a size read from a scan is rarely a whole number)
      const own = Math.round(cur.size * 10) / 10;
      const sizes = SIZES.includes(own) ? SIZES : SIZES.concat([own]).sort((a, b) => a - b);
      const size = el('select', { class: 'tb-select', 'aria-label': _('Size'), title: _('Size') }, sizes.map((n) => el('option', { value: n, selected: Math.abs(n - cur.size) < 0.05 }, String(n))));
      size.addEventListener('change', () => { st.size = +size.value; update((i) => { i.size = +size.value; }); });
      const color = el('input', { type: 'color', class: 'pdf-color', value: cur.color || '#000000', 'aria-label': _('Text color'), title: _('Text color') });
      color.addEventListener('change', () => { st.color = color.value; update((i) => { i.color = color.value; }); });
      const tog = (icon, label, prop) => {
        const b = el('button', { type: 'button', class: 'tb' + (cur[prop] ? ' on' : ''), 'data-icon': icon, title: label, 'aria-label': label, 'aria-pressed': cur[prop] ? 'true' : 'false' });
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          const v = !(it ? it[prop] : st[prop]);
          st[prop] = v;
          b.classList.toggle('on', v);
          update((i) => {
            i[prop] = v;
            // drawn in the page's matched font: switch that font's weight or slant,
            // for the whole line (words set apart in it included)
            if (i.font && typeof NpFonts !== 'undefined') {
              const ws = (NpFonts.CATALOG[i.font.id] && NpFonts.CATALOG[i.font.id][2]) || [400, 700];
              const near = (w) => ws.reduce((a, c) => (Math.abs(c - w) < Math.abs(a - w) ? c : a), ws[0]);
              if (prop === 'bold') i.font = Object.assign({}, i.font, { weight: near(v ? 700 : 400) });
              else i.font = Object.assign({}, i.font, { style: v ? 'italic' : 'normal' });
              // new word objects in a new array: undo snapshots share the old ones
              if (i.words && i.words.some((w) => w.v)) {
                i.words = i.words.map((w) => {
                  if (!w.v) return w;
                  const v = Object.assign({}, w.v, prop === 'bold' ? { weight: i.font.weight } : { style: i.font.style });
                  const n = Object.assign({}, w, { v });
                  if (v.weight === i.font.weight && v.style === i.font.style) delete n.v;
                  return n;
                });
              }
              const info = S.info.get(i.page);
              Promise.all(itemFonts(i).map((f) => NpFonts.load(f).catch(() => null))).then(() => { if (info && !S.editing) renderOverlay(info); });
            }
          });
        });
        return b;
      };
      parts.push(fam, size, color, tog('bold', _('Bold'), 'bold'), tog('italic', _('Italic'), 'italic'));
    } else if (kind === 'ink' || kind === 'draw' || kind === 'box') {
      const isInk = kind === 'ink' || kind === 'draw';
      const cur = it ? it.color : (isInk ? st.ink : st.box);
      const wcur = it ? it.width : (isInk ? st.inkWidth : st.boxWidth);
      const color = el('input', { type: 'color', class: 'pdf-color', value: cur, 'aria-label': _('Color'), title: _('Color') });
      color.addEventListener('change', () => { if (isInk) st.ink = color.value; else st.box = color.value; update((i) => { i.color = color.value; }); });
      const width = el('select', { class: 'tb-select', 'aria-label': _('Line width'), title: _('Line width') }, [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12].map((n) => el('option', { value: n, selected: n === wcur }, n + ' pt')));
      width.addEventListener('change', () => { if (isInk) st.inkWidth = +width.value; else st.boxWidth = +width.value; update((i) => { i.width = +width.value; }); });
      parts.push(color, width);
    } else if (kind === 'highlight' || kind === 'whiteout') {
      const prop = kind === 'highlight' ? 'hl' : 'white';
      const color = el('input', { type: 'color', class: 'pdf-color', value: it ? it.color : st[prop], 'aria-label': _('Color'), title: _('Color') });
      color.addEventListener('change', () => { st[prop] = color.value; update((i) => { i.color = color.value; }); });
      parts.push(color);
    }
    if (it && it.type === 'hand') {
      const b = el('button', { type: 'button', class: 'btn btn-sm', title: it.erased ? _('Show this handwriting again') : _('Take this handwriting off the page (Del)') }, it.erased ? _('Put back') : _('Erase handwriting'));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => setHand([it], !it.erased));
      const hint = it.erased && it.parts ? el('span', { class: 'pdf-style-hint' }, _('Click a piece to keep or erase it')) : null;
      bar.replaceChildren(...[b, hint].filter(Boolean));
      bar.hidden = false;
      return;
    }
    if (it && it.conv && it.words.length && !it.para) {
      // a line that should not have been retyped (writing, a logo): back to the scan's own pixels
      const sc = el('button', { type: 'button', class: 'btn btn-sm', title: _('Show this line exactly as it is on the scan, not retyped') }, _('Show as scanned'));
      sc.addEventListener('mousedown', (e) => e.preventDefault());
      sc.addEventListener('click', () => {
        const before = snap();
        S.rec.items = S.rec.items.filter((i) => i !== it);
        S.sel = null;
        commit(before);
        const info = S.info.get(it.page);
        info.text = null;
        renderOverlay(info);
        renderStyleBar();
      });
      parts.push(sc);
    }
    if (it) {
      if (it.cover) {
        const restore = el('button', { type: 'button', class: 'btn btn-sm', title: _('Remove this change and show the original text again') }, _('Restore original'));
        restore.addEventListener('click', () => deleteSelected());
        parts.push(restore);
      }
      const del = el('button', { type: 'button', class: 'tb', 'data-icon': 'trash', title: _('Delete (Del)'), 'aria-label': 'Delete' });
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
    if (it.conv) it.text = '';
    else if (it.type === 'hand') { setHand([it], true); return; }
    else S.rec.items = S.rec.items.filter((i) => i.id !== it.id);
    S.sel = null;
    commit(before);
    renderOverlay(S.info.get(it.page));
    renderStyleBar();
  }

  function node0Before(it) {
    const info = S.info.get(it.page);
    const node = info && info.layer.querySelector('[data-id="' + it.id + '"]');
    return (node && S.nodeBefore.get(node)) || null;
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
      if (it.anchored || it.conv || it.type === 'hand') return false;
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
        if (/times|serif|roman|georgia|garamond/i.test(name)) name = 'Times-' + (bold && ital ? 'BoldItalic' : bold ? _('Bold') : ital ? _('Italic') : 'Roman');
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
    const fonts = resources && resources.lookup(N(_('Font')));
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
    closePdf(pdoc);

    // page space → image unit square → pixels (image row 0 is the top)
    const [a, b, c, d, e, f] = ctm;
    const det = a * d - b * c;
    if (!det) return null;
    const toPx = (x, y) => {
      const u = (d * (x - e) - c * (y - f)) / det;
      const v = (a * (y - f) - b * (x - e)) / det;
      return [u * cw, (1 - v) * ch];
    };
    // Converted text: repainted with the paper around each word.
    const soft = hits.filter((r) => r.inpaint);
    if (soft.length) {
      const pxPerPt = Math.hypot(...[0, 1].map((k) => toPx(1, 0)[k] - toPx(0, 0)[k]));
      const pxRect = (r) => {
        const cs = [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]].map(([x, y]) => toPx(x, y));
        return { x0: Math.min(...cs.map((q) => q[0])), y0: Math.min(...cs.map((q) => q[1])), x1: Math.max(...cs.map((q) => q[0])), y1: Math.max(...cs.map((q) => q[1])), em: (r.em || 0) * pxPerPt };
      };
      const skip = [];
      for (const r of soft) for (const q of r.keep || []) skip.push(pxRect(q));
      const img2 = g.getImageData(0, 0, cw, ch);
      // the page's lines as they lie in this image's pixels (turned, if the
      // page was straightened)
      const ox = toPx(0, 0);
      const ux = toPx(1, 0);
      const uy = toPx(0, 1);
      const a = [ux[0] - ox[0], ux[1] - ox[1]];
      const b = [uy[0] - ox[0], uy[1] - ox[1]];
      const across = Math.abs(a[0]) >= Math.abs(a[1]) ? a : b;
      const down = across === a ? b : a;
      const tA = across[1] / across[0];
      const tB = down[0] / down[1];
      const runs = Math.abs(tA) > 0.0005 || Math.abs(tB) > 0.0005 ? lineRuns(img2.data, cw, ch, tA, tB) : null;
      inpaint(img2.data, cw, ch, soft.map(pxRect), skip, runs);
      g.putImageData(img2, 0, 0);
    }
    for (const r of hits) {
      if (r.inpaint) continue;
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
      if (/encrypt/i.test(String(e && e.message))) throw new Error(_('This PDF is password-protected, so it cannot be saved with changes.'));
      throw e;
    }
    // the document's language, for screen readers and other programs
    if (rec.lang) { try { base.setLanguage(rec.lang); } catch (e) { /* ignore */ } }
    const warnings = [];
    // fonts painted into scans must be ready before the canvas draws them
    if (typeof NpFonts !== 'undefined') await Promise.all((rec.items || []).flatMap(itemFonts).map((f) => NpFonts.load(f).catch(() => null)));

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
        } catch (e) { warnings.push('“' + name + '”'); }
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
            // a font made from the scan's letters (a CFF font) goes in whole:
            // the subsetter breaks that kind
            const scanMade = /-scan\d+$/.test(NpFonts.cssFamily(it.font));
            fonts[key] = await base.embedFont(await NpFonts.bytes(it.font), { subset: !scanMade });
            if (scanMade) cffFonts.push(fonts[key]);
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
    const cffFonts = [];
    let replaced = 0;
    let erased = 0;
    let coveredNothing = 0;
    let overflowed = 0;

    for (const { entry, page, baseRot } of final) {
      const R = ((baseRot + entry.rotate) % 360 + 360) % 360;
      page.setRotation(L.degrees(R));
      if (entry.skew) {
        // the crooked scan turned straight about the page's center: a counter-
        // clockwise turn on screen is the same turn in the page's own space
        const cb = page.getCropBox();
        const a = (entry.skew * Math.PI) / 180;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const cx = cb.x + cb.width / 2;
        const cy = cb.y + cb.height / 2;
        page.node.normalize();
        const ctx0 = base.context;
        const pc = hexRgb(entry.paper || '#ffffff');
        page.node.wrapContentStreams(
          ctx0.register(ctx0.contentStream([L.pushGraphicsState(), L.setFillingRgbColor(pc.red, pc.green, pc.blue), L.rectangle(cb.x, cb.y, cb.width, cb.height), L.fill(), L.popGraphicsState(),
            L.pushGraphicsState(), L.concatTransformationMatrix(c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy)])),
          ctx0.register(ctx0.contentStream([L.popGraphicsState()])));
      }
      const items = (rec.items || []).filter((i) => i.page === entry.uid);
      const ocr = rec.ocr && ocrFits(rec.ocr[entry.uid], entry, R) ? rec.ocr[entry.uid].lines : [];
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
        if (it.type === 'hand') {
          const hr = handRects(it);
          const keep = hr.keep.map((b) => rectToPdf(R, box, b.x, b.y, b.w, b.h));
          for (const b of hr.rects) regions.push(Object.assign(rectToPdf(R, box, b.x, b.y, b.w, b.h), { color: '#ffffff', inpaint: true, em: b.em, keep }));
        }
        if (it.conv) {
          const cr = convRects(it);
          const keep = cr.keep.map((b) => rectToPdf(R, box, b.x, b.y, b.w, b.h));
          for (const b of cr.rects) regions.push(Object.assign(rectToPdf(R, box, b.x, b.y, b.w, b.h), { color: it.bg, inpaint: true, em: it.size, keep }));
        }
        if (it.anchored) {
          const lay = layoutEdit(it);
          layouts.set(it.id, lay);
          for (const c of lay.covers) regions.push(Object.assign(rectToPdf(R, box, c.x, c.y, c.w, c.h), { color: it.bg, inpaint: true, em: it.size }));
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
      // Converted lines: the scan's words are gone from the file; draw the text.
      for (const it of items) {
        if (!it.conv) continue;
        if (!erasedHere) for (const b of convRects(it).rects) { page.drawRectangle(Object.assign(rectToPdf(R, box, b.x, b.y, b.w, b.h), { color: hexRgb(it.bg) })); }
        let over = false;
        for (const r of convLayout(it)) {
          const matched = await fontFor(r.st);
          const charset = r.st.font && matched && matched.getCharacterSet ? new Set(matched.getCharacterSet()) : null;
          const font = charset && [...r.text].some((ch) => !charset.has(ch.codePointAt(0)))
            ? await fontFor(Object.assign({}, r.st, { font: null })) : matched;
          let safe = '';
          for (const ch of r.text) { try { font.encodeText(ch); safe += ch; } catch (e) { safe += '?'; replaced++; } }
          if (Math.abs(r.scaleX - 1) > 0.002) page.pushOperators(L.pushGraphicsState(), L.setCharacterSqueeze(r.scaleX * 100));
          let xd = r.x;
          for (const q of it.smallCaps ? scParts(safe, it.smallCaps) : [{ t: safe, k: 1 }]) {
            const [x, y] = toPdf(R, box, xd, r.base);
            page.drawText(q.t, { x, y, size: it.size * q.k, font, color: hexRgb(it.color), rotate: L.degrees(R) });
            xd += font.widthOfTextAtSize(q.t, it.size * q.k) * r.scaleX;
          }
          if (Math.abs(r.scaleX - 1) > 0.002) page.pushOperators(L.popGraphicsState());
          over = over || r.overflow;
        }
        if (over) overflowed++;
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
        } else if (it.type === 'text' && it.text && !it.anchored && !it.conv) {
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
    // pdf-lib files every font it embeds whole as TrueType; those made from
    // the scan's letters are CFF fonts, so their entries are put right
    if (cffFonts.length) {
      await base.flush();
      const N = L.PDFName.of;
      for (const f of cffFonts) {
        try {
          const dict = base.context.lookup(f.ref);
          const cid = dict.lookup(N('DescendantFonts')).lookup(0);
          cid.set(N('Subtype'), N('CIDFontType0'));
          cid.delete(N('CIDToGIDMap'));
          const fd = cid.lookup(N('FontDescriptor'));
          const fileRef = fd.get(N('FontFile2'));
          if (fileRef) {
            base.context.lookup(fileRef).dict.set(N('Subtype'), N('OpenType'));
            fd.delete(N('FontFile2'));
            fd.set(N('FontFile3'), fileRef);
          }
        } catch (e) { /* left as embedded */ }
      }
    }
    const bytes = await base.save({ updateFieldAppearances: false });
    if (replaced) api.toast(_n(replaced, '{n} character could not be written with the PDF’s standard fonts and became “?”.', '{n} characters could not be written with the PDF’s standard fonts and became “?”.'), 6000);
    if (overflowed) api.toast(_('Some edited text is longer than the space it had, so it runs past the end of its line. Shorten it if it overlaps something.'), 7000);
    if (coveredNothing) api.toast(_('Some covered areas had nothing underneath to remove except drawings. Those are hidden, but still inside the file.'), 7000);
    if (warnings.length) api.toast(_('Some form fields could not be filled: {fields}', { fields: warnings.slice(0, 3).join(', ') }), 6000);

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
      if (act === 'original') toggleOriginal();
      if (b.classList.contains('tb-info')) b.classList.toggle('open');
    });
    $('#pdf-scroller').addEventListener('scroll', () => { if (!S.raf) S.raf = requestAnimationFrame(() => { S.raf = 0; updatePageStatus(); }); }, { passive: true });
    window.addEventListener('resize', () => { if (S.rec && S.fit && document.body.classList.contains('pdf-mode')) fitWidth(); });
    // pages read in the last few seconds are saved when the tab is closed or hidden
    const flush = () => { if (S.rec && saveSoon) bgChanged(true); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    const ra = $('#pdf-readall');
    if (ra) ra.addEventListener('change', () => { if (S.rec) setReadAll(ra.checked); });
    // the info bubble: placed under its button within the window (the toolbar
    // scrolls sideways on a phone, and would cut it off); it opens on hover,
    // focus or tap, and closes on a click elsewhere
    const info = $('#pdf-toolbar .tb-info');
    if (info) {
      const place = () => {
        const tip = info.querySelector('.tb-tip');
        const r = info.getBoundingClientRect();
        const w = Math.min(300, innerWidth - 24);
        tip.style.left = clamp(r.left + r.width / 2 - w / 2, 12, innerWidth - w - 12) + 'px';
        tip.style.top = r.bottom + 8 + 'px';
      };
      info.addEventListener('mouseenter', place);
      info.addEventListener('focus', place);
      info.addEventListener('click', place);
    }
    document.addEventListener('pointerdown', (e) => { const i = $('#pdf-toolbar .tb-info.open'); if (i && !i.contains(e.target)) i.classList.remove('open'); });
    const addInput = $('#pdf-add-input');
    addInput.addEventListener('change', async () => {
      const files = Array.from(addInput.files);
      addInput.value = '';
      for (const f of files) await addPagesFrom(f);
    });
  }

  /* ============================================================ translation */

  // Every scanned page not read yet, read now (in the document's language)
  // and made editable; onPage(done, total) as each finishes.
  async function readEverything(onPage) {
    const rec = S.rec;
    const todo = [];
    for (const p of rec.pages) {
      const info = S.info.get(p.uid);
      if (info && (await needsReading(info))) todo.push(info);
    }
    if (!todo.length) return;
    await tesseract();
    let done = 0;
    if (onPage) onPage(0, todo.length);
    for (const info of todo) {
      if (S.rec !== rec) return;
      await readPage(info);
      if (onPage) onPage(++done, todo.length);
    }
  }

  // The translated text spread over a paragraph's lines, as a translator
  // keeps a page's layout: the lines it had, no more, at the size it had or
  // smaller (down to 60%) where the translation runs longer. Past that, the
  // last line takes the rest and is narrowed as an edited line is.
  // lines: [{ room, width(text, k) }] → { k, texts }
  function fitLines(lines, words) {
    for (const k of [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6]) {
      const texts = [];
      let pos = 0;
      for (const l of lines) {
        let n = 0;
        while (pos + n < words.length && (n === 0 || l.width(words.slice(pos, pos + n + 1).join(' '), k) <= l.room)) n++;
        if (n && l.width(words.slice(pos, pos + n).join(' '), k) > l.room && k > 0.6) break; // one word too long for its line
        texts.push(words.slice(pos, pos + n).join(' '));
        pos += n;
      }
      if (pos >= words.length && texts.length === lines.length) return { k, texts };
    }
    const texts = [];
    let pos = 0;
    lines.forEach((l, i) => {
      let n = 0;
      if (i === lines.length - 1) n = words.length - pos;
      else while (pos + n < words.length && (n === 0 || l.width(words.slice(pos, pos + n + 1).join(' '), 0.6) <= l.room)) n++;
      texts.push(words.slice(pos, pos + n).join(' '));
      pos += n;
    });
    return { k: 0.6, texts };
  }
  const splitWords = (s) => String(s || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

  // A page made editable from a scan: its paragraphs (or single lines).
  function convUnits(uidv) {
    const lines = S.rec.items.filter((i) => i.page === uidv && i.conv && i.text && i.text.trim());
    const out = [];
    const seen = new Set();
    for (const l of lines.sort((a, b) => a.base - b.base || lineStart(a) - lineStart(b))) {
      if (l.para) {
        if (seen.has(l.para)) continue;
        seen.add(l.para);
        out.push({ conv: paraLines(l.para) });
      } else out.push({ conv: [l] });
    }
    return out;
  }

  function fitConv(lines, text) {
    const g = lines.length > 1 ? paraGeom(lines) : null;
    const sizes = lines.map((l) => l.size);
    const fit = fitLines(lines.map((l, i) => {
      const x = lineStart(l);
      const lastX1 = l.words.length ? l.words[l.words.length - 1].x1 : x;
      const right = g ? Math.min(g.right, l.limit != null ? l.limit : Infinity) : (l.limit != null ? Math.max(l.limit, lastX1) : lastX1 + l.size * 0.2);
      return {
        room: right - x + 0.5,
        width: (t, k) => {
          const lay = convLayout(Object.assign({}, l, { text: t, tv: undefined, size: sizes[i] * k, limit: Infinity }));
          const r = lay[lay.length - 1];
          return r ? r.x + measureRun(r.text, r.st, l.smallCaps).w * r.scaleX - x : 0;
        }
      };
    }), splitWords(text));
    lines.forEach((l, i) => {
      l.text = fit.texts[i] || '';
      l.tv = undefined;
      l.size = Math.round(sizes[i] * fit.k * 10) / 10;
      l.y = l.base - BASELINE[l.family || 'sans'] * l.size;
    });
  }

  // A page with text of its own: its runs joined into lines (a column gap
  // keeps them apart), and the lines into paragraphs, as groupParagraphs
  // does for a scan's lines.
  async function typedUnits(info) {
    const runs = (await textItems(info)).filter((t) => !t.scan).sort((a, b) => a.base - b.base || a.x - b.x);
    const lines = [];
    for (const t of runs) {
      const l = lines.find((q) => Math.abs(q.base - t.base) < Math.max(q.size, t.size) * 0.4 && t.x > q.x1 - t.size * 0.5 && t.x - q.x1 < t.size * 2.5);
      if (l) { l.ts.push(t); l.x1 = Math.max(l.x1, t.x + t.w); l.size = Math.max(l.size, t.size); } else lines.push({ ts: [t], base: t.base, size: t.size, x0: t.x, x1: t.x + t.w });
    }
    lines.sort((a, b) => a.base - b.base || a.x0 - b.x0);
    const taken = new Set();
    const out = [];
    for (const a of lines) {
      if (taken.has(a)) continue;
      const group = [a];
      taken.add(a);
      let cur = a;
      for (;;) {
        const b = lines.find((q) => !taken.has(q) && q.base - cur.base >= cur.size * 0.9 && q.base - cur.base <= cur.size * 1.9 &&
          Math.min(q.x1, cur.x1) - Math.max(q.x0, cur.x0) > Math.min(q.x1 - q.x0, cur.x1 - cur.x0) * 0.3);
        if (!b || Math.abs(b.size - cur.size) > cur.size * 0.18) break;
        if (group.length >= 2 && Math.abs((b.base - cur.base) - (cur.base - group[group.length - 2].base)) > cur.size * 0.25) break;
        if (group.length >= 2 ? Math.abs(b.x0 - group[1].x0) > cur.size * 0.8 : b.x0 > cur.x0 + cur.size * 0.8 || b.x0 < cur.x0 - cur.size * 4) break;
        // the line before was full: the next one's first word would not have fitted on it
        const right = Math.max(b.x1, ...group.map((q) => q.x1));
        const first = splitWords(b.ts[0].str)[0] || '';
        if (cur.x1 + textWidth(' ' + first, { family: b.ts[0].family, size: b.size }) < right - cur.size * 0.1) break;
        group.push(b);
        taken.add(b);
        cur = b;
      }
      out.push({ typed: group });
    }
    return out.filter((u) => u.typed.some((l) => l.ts.some((t) => /\p{L}/u.test(t.str))));
  }

  // Each run of a line gets an edit: the first carries the line's new text,
  // the rest are emptied (their words covered).
  async function typedEdits(info, lines) {
    const existing = new Map(S.rec.items.filter((i) => i.page === info.entry.uid && i.anchored).map((i) => [i.origKey, i]));
    const out = [];
    // colors from a render of its own: the page on screen may not be drawn yet
    let view = null;
    const drawn = async () => {
      if (view) return view;
      const K = Math.min(2, 2400 / Math.max(info.w, info.h));
      const c = document.createElement('canvas');
      c.width = Math.round(info.w * K);
      c.height = Math.round(info.h * K);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.fillStyle = paperOf(info);
      g.fillRect(0, 0, c.width, c.height);
      await info.page.render(renderOpts(info, g, K)).promise;
      return (view = { canvas: c, w: info.w });
    };
    for (const l of lines) {
      const its = [];
      for (const t of l.ts) {
        let it = existing.get(t.key);
        if (!it) {
          const words = nativeWords(info, t);
          if (!words.length) continue;
          const y0 = Math.min(...words.map((w) => w.y0));
          const ink = sampleInk(await drawn(), { x: words[0].x0, y: y0, w: words[words.length - 1].x1 - words[0].x0, h: Math.max(...words.map((w) => w.y1)) - y0 });
          let bold = false;
          let italic = false;
          try {
            const f = info.page.commonObjs.get(t.fontName);
            const name = (f && (f.name || f.loadedName)) || '';
            bold = !!(f && f.bold) || /bold|black|heavy|semibold|demi/i.test(name);
            italic = !!(f && f.italic) || /italic|oblique/i.test(name);
          } catch (e) { /* font not resolved yet */ }
          const size = Math.round(t.size * 10) / 10;
          const origText = words.map((w) => w.t).join(' ');
          it = {
            id: uid(), type: 'text', page: info.entry.uid, origKey: t.key, anchored: true, scan: false, limit: await lineLimit(info, t, words),
            words, origText, text: origText, x: words[0].x0, base: t.base, y: t.base - BASELINE[t.family] * size, heightSize: t.size,
            size, family: t.family, color: ink.fg, bg: ink.bg, bold, italic
          };
          S.rec.items.push(it);
          await matchFont(info, t, it, words);
        }
        its.push(it);
      }
      if (its.length) out.push(its);
    }
    return out;
  }

  function fitTyped(edits, text) {
    const lastX1 = (its) => Math.max(...its.map((i) => i.words[i.words.length - 1].x1));
    // a paragraph wraps at its right edge; a line alone may run to the next
    // text on its line, a cell border or the margin
    const right = edits.length > 1 ? Math.max(...edits.map(lastX1)) : null;
    const ends = edits.map((its) => {
      const l = its[0];
      return right != null ? right + l.size * 0.2 : Math.max(l.limit != null ? l.limit : 0, lastX1(its) + l.size * 0.2);
    });
    const sizes = edits.map((its) => its[0].size);
    const fit = fitLines(edits.map((its, i) => {
      const l = its[0];
      return { room: ends[i] - l.words[0].x0, width: (t, k) => textWidth(t, Object.assign({}, l, { size: sizes[i] * k })) };
    }), splitWords(text));
    edits.forEach((its, i) => {
      const l = its[0];
      l.text = fit.texts[i] || '';
      l.size = Math.round(sizes[i] * fit.k * 10) / 10;
      l.y = l.base - BASELINE[l.family || 'sans'] * l.size;
      l.limit = ends[i];
      for (const q of its.slice(1)) q.text = '';
    });
  }

  // The open document translated where it stands, page by page: each
  // paragraph's text replaced in its place. tr(text) → Promise<text>.
  // onProgress(what, done, total).
  async function translateOpen(tr, onProgress) {
    const rec = S.rec;
    if (!rec) return 0;
    const say = onProgress || (() => {});
    await readEverything((d, n) => say('read', d, n));
    if (S.rec !== rec) return 0;
    const before = snap();
    let count = 0;
    for (const [pi, p] of rec.pages.entries()) {
      const info = S.info.get(p.uid);
      if (!info || !info.page) continue;
      say('page', pi, rec.pages.length);
      const units = isConv(p.uid) ? convUnits(p.uid) : (await isScanPage(info)) ? [] : await typedUnits(info);
      const typed = [];
      for (const u of units) if (u.typed) typed.push({ u, edits: await typedEdits(info, u.typed) });
      await Promise.all(units.map(async (u) => {
        if (u.conv) {
          const text = u.conv.map((l) => l.text).join(' ');
          fitConv(u.conv, await tr(text));
          count++;
          return;
        }
        const e = typed.find((q) => q.u === u).edits;
        if (!e.length) return;
        const text = e.map((its) => its.map((i) => i.text).join(' ')).join(' ');
        fitTyped(e, await tr(text));
        count++;
      }));
      if (S.rec !== rec) return count;
      renderOverlay(info);
    }
    say('page', rec.pages.length, rec.pages.length);
    commit(before);
    api.saved();
    return count;
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
    closePdf(doc);
    return { pages: Array.from({ length: n }, (_, i) => ({ uid: uid(), src: 0, index: i, rotate: 0 })), text: text.replace(/[ \t]+/g, ' ').trim() };
  }

  async function suggestOcr(rec) {
    // a PDF whose first page has no text of its own is almost always a scan
    const first = S.info.get(rec.pages[0] && rec.pages[0].uid);
    if (!first || !first.page || (rec.ocr && Object.keys(rec.ocr).length)) return;
    if ((await isScanPage(first)) && S.rec === rec) api.toast(rec.origin ? _('With Edit text, click the image to read it and make its words editable, or turn on Read whole document.') : _('This PDF is a scan (or its letters were saved as shapes). With Edit text, click a page to read it and make its words editable, or turn on Read whole document.'), 8000);
  }

  window.NpPdf = {
    // the closest fonts from the last look-based match, for diagnosing a poor match
    get lastMatch() { return S.lastMatch; },
    init, open, close, newRecord,
    // whether scans can be read in a language
    readsLanguage: (code) => !!readLangOf(code),
    libs: loadLibs,
    export: exportPdf,
    // a finished PDF (as a Blob) opened for viewing: { count, page(i), destroy() }
    view: async (blob) => {
      await loadLibs();
      const doc = await loadPdfJs(await blob.arrayBuffer());
      return { count: doc.numPages, page: (i) => doc.getPage(i + 1), destroy: () => closePdf(doc) };
    },
    undo, redo, zoom,
    setTool, onKey,
    rotateCurrent: (dir) => { const c = currentPage(); if (c) rotatePage(c.entry.uid, dir); },
    deleteCurrent: () => { const c = currentPage(); if (c) deletePage(c.entry.uid); },
    insertBlank,
    ocr: (scope) => (scope === 'current' ? (currentPage() && clickRead(currentPage(), -1, -1)) : setReadAll(true)),
    readAll: (on) => setReadAll(on),
    convert: convertCurrent,
    unconvert: unconvertCurrent,
    toggleScanFonts,
    showOriginal: () => toggleOriginal(),
    copyText: copyPageText,
    addPages: () => $('#pdf-add-input').click(),
    get active() { return !!S.rec; },
    finishEditing,
    // every scanned page read now; the open document translated in place
    readEverything, translate: translateOpen
  };
})();
