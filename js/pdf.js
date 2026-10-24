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
    try { await info.task.promise; } catch (e) { /* cancelled by a newer render */ }
    info.task = null;
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
    const mine = S.rec.items.filter((i) => i.page === info.entry.uid);
    // patches over replaced text go underneath everything else
    for (const it of mine) {
      if (it.cover) layer.append(el('div', { class: 'pdf-cover', style: 'left:' + px(it.cover.x) + ';top:' + px(it.cover.y) + ';width:' + px(it.cover.w) + ';height:' + px(it.cover.h) + ';background:' + it.cover.color }));
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
    if (it.type === 'text') {
      const d = el('div', {
        class: 'pdf-item pdf-textbox' + (sel ? ' sel' : ''), 'data-id': it.id,
        style: 'left:' + px(it.x) + ';top:' + px(it.y) + ';font-size:' + px(it.size) + ';font-family:' + CSS_FAMILY[it.family] +
          ';color:' + it.color + ';font-weight:' + (it.bold ? 700 : 400) + ';font-style:' + (it.italic ? 'italic' : 'normal')
      });
      d.textContent = it.text;
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
    info.text = out;
    return out;
  }

  async function renderTextTargets(info) {
    const items = await textItems(info);
    if (S.tool !== 'edit' || !info.layer.isConnected) return;
    const used = new Set(S.rec.items.filter((i) => i.origKey).map((i) => i.origKey));
    const frag = document.createDocumentFragment();
    for (const t of items) {
      if (used.has(t.key)) continue;
      frag.append(el('div', { class: 'pdf-target', 'data-key': t.key, title: 'Click to edit', style: 'left:' + px(t.x) + ';top:' + px(t.top) + ';width:' + px(Math.max(t.w, 2)) + ';height:' + px(t.size * 1.15) }));
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
    const before = snap();
    const entry = S.rec.pages.find((p) => p.uid === uidv);
    if (!entry) return;
    measureTextItems();
    rotateItems(uidv, dir);
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
      if (target) { e.preventDefault(); editOriginal(info, target.dataset.key); }
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
      if (!moved && Math.hypot(dx, dy) * S.scale < 3) return;
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
    renderOverlay(info);
    S.editing = id;
    const node = info.layer.querySelector('[data-id="' + id + '"]');
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
    const node = info && info.layer.querySelector('[data-id="' + id + '"]');
    if (!it || !node) return;
    const before = node.dataset.isNew ? null : node.dataset.before;
    const text = node.innerText.replace(/\r/g, '').replace(/\n$/, '');
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
      if (!text.trim() && !it.cover) {
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
    it.w = node.offsetWidth / S.scale;
    it.h = node.offsetHeight / S.scale;
  }

  function measureTextItems() {
    for (const info of S.info.values()) {
      for (const node of info.layer.querySelectorAll('.pdf-textbox')) {
        const it = itemById(node.getAttribute('data-id'));
        if (it) measure1(it, node);
      }
    }
  }

  // Replace a run of the PDF's own text: patch over it, then put an editable
  // copy in a matching standard font on top.
  async function editOriginal(info, key) {
    const t = (await textItems(info)).find((x) => x.key === key);
    if (!t) return;
    const before = snap();
    const bg = sampleColor(info, t, true);
    const fg = sampleColor(info, t, false, bg);
    let bold = false;
    let italic = false;
    try {
      const f = info.page.commonObjs.get(t.fontName);
      const name = (f && (f.name || f.loadedName)) || '';
      bold = !!(f && f.bold) || /bold|black|heavy|semibold|demi/i.test(name);
      italic = !!(f && f.italic) || /italic|oblique/i.test(name);
    } catch (e) { /* font not resolved yet */ }
    const fam = t.family;
    const size = Math.round(t.size * 10) / 10;
    const it = {
      id: uid(), type: 'text', page: info.entry.uid, origKey: key,
      x: t.x, y: t.base - BASELINE[fam] * size, size, family: fam, color: fg, bold, italic, text: t.str, origText: t.str,
      cover: { x: t.x - 1, y: t.base - t.size * 1.0 - 1, w: t.w + 2, h: t.size * 1.3 + 2, color: bg }
    };
    S.rec.items.push(it);
    renderOverlay(info);
    startEditing(it.id);
    const node = info.layer.querySelector('[data-id="' + it.id + '"]');
    if (node) { node.dataset.before = before; node.dataset.fresh = '1'; }
  }

  function sampleColor(info, t, background, bg) {
    try {
      const c = info.canvas;
      const k = c.width / info.w;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const x = Math.max(0, Math.floor((t.x - 2) * k));
      const y = Math.max(0, Math.floor((t.base - t.size * 1.05) * k));
      const w = Math.min(c.width - x, Math.ceil((t.w + 4) * k));
      const h = Math.min(c.height - y, Math.ceil(t.size * 1.35 * k));
      if (w <= 0 || h <= 0) return background ? '#ffffff' : '#000000';
      const d = ctx.getImageData(x, y, w, h).data;
      const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
      if (background) {
        // the most common color along the edges of the box
        const counts = new Map();
        const add = (i) => { const key = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3); const v = counts.get(key) || [0, d[i], d[i + 1], d[i + 2]]; v[0]++; counts.set(key, v); };
        for (let xx = 0; xx < w; xx++) { add(xx * 4); add(((h - 1) * w + xx) * 4); }
        for (let yy = 0; yy < h; yy++) { add(yy * w * 4); add((yy * w + w - 1) * 4); }
        let best = null;
        for (const v of counts.values()) if (!best || v[0] > best[0]) best = v;
        return best ? hex(best[1], best[2], best[3]) : '#ffffff';
      }
      const b = bg ? [parseInt(bg.slice(1, 3), 16), parseInt(bg.slice(3, 5), 16), parseInt(bg.slice(5, 7), 16)] : [255, 255, 255];
      let far = 0;
      let col = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        const dist = Math.abs(d[i] - b[0]) + Math.abs(d[i + 1] - b[1]) + Math.abs(d[i + 2] - b[2]);
        if (dist > far) { far = dist; col = [d[i], d[i + 1], d[i + 2]]; }
      }
      return far < 60 ? '#000000' : hex(col[0], col[1], col[2]);
    } catch (e) {
      return background ? '#ffffff' : '#000000';
    }
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
      const fam = el('select', { class: 'tb-select', 'aria-label': 'Font', title: 'Font' },
        [['sans', 'Sans (Helvetica)'], ['serif', 'Serif (Times)'], ['mono', 'Mono (Courier)']].map(([v, l]) => el('option', { value: v, selected: cur.family === v }, l)));
      fam.addEventListener('change', () => { st.family = fam.value; update((i) => { i.family = fam.value; }); });
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
    node.style.fontFamily = CSS_FAMILY[it.family];
    node.style.color = it.color;
    node.style.fontWeight = it.bold ? 700 : 400;
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

    for (const { entry, page, baseRot } of final) {
      const R = ((baseRot + entry.rotate) % 360 + 360) % 360;
      page.setRotation(L.degrees(R));
      const items = (rec.items || []).filter((i) => i.page === entry.uid);
      if (!items.length) continue;
      const box = page.getCropBox();
      // Keep the page's own drawing state from leaking into ours.
      page.node.normalize();
      const ctx = base.context;
      page.node.wrapContentStreams(ctx.register(ctx.contentStream([L.pushGraphicsState()])), ctx.register(ctx.contentStream([L.popGraphicsState()])));

      for (const it of items) if (it.cover) {
        page.drawRectangle(Object.assign(rectToPdf(R, box, it.cover.x, it.cover.y, it.cover.w, it.cover.h), { color: hexRgb(it.cover.color) }));
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
        } else if (it.type === 'text' && it.text) {
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

  window.NpPdf = {
    init, open, close, newRecord,
    export: exportPdf,
    undo, redo, zoom,
    setTool, onKey,
    rotateCurrent: (dir) => { const c = currentPage(); if (c) rotatePage(c.entry.uid, dir); },
    deleteCurrent: () => { const c = currentPage(); if (c) deletePage(c.entry.uid); },
    insertBlank,
    addPages: () => $('#pdf-add-input').click(),
    get active() { return !!S.rec; },
    finishEditing
  };
})();
