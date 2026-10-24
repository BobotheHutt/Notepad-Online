/* Notepad Online — the app.
   Sections: helpers · settings · documents · editor core · toolbar state ·
   menus · popovers · dialogs · find & replace · images · tables · links ·
   files · sidebar · status · speech · views · boot */
(() => {
  'use strict';

  /* =========================================================== helpers */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const editor = $('#editor');
  const page = $('#page');
  const workspace = $('#workspace');
  const titleInput = $('#doc-title');
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);

  // Shown in Tools → About, so it is easy to tell which version is running.
  const APP_VERSION = '2026.10.24-15';

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function debounce(fn, ms) {
    let t;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.cancel = () => clearTimeout(t);
    d.flush = (...a) => { clearTimeout(t); return fn(...a); };
    return d;
  }

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 200); }, ms);
  }

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function ago(t) {
    const s = (t - Date.now()) / 1000;
    if (Math.abs(s) < 45) return 'just now';
    const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
    let v = s;
    for (let i = 0; i < steps.length; i++) {
      const [n, unit] = steps[i];
      if (Math.abs(v) < n) return rtf.format(Math.round(v), unit);
      v /= n;
    }
    return '';
  }
  const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtNum = (n) => n.toLocaleString();

  /* =========================================================== constants */

  const FONTS = [
    { key: 'sans', label: 'Sans (default)', css: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
    { key: 'arial', label: 'Arial', css: 'Arial, Helvetica, sans-serif' },
    { key: 'verdana', label: 'Verdana', css: 'Verdana, Geneva, sans-serif' },
    { key: 'trebuchet', label: 'Trebuchet MS', css: '"Trebuchet MS", Helvetica, sans-serif' },
    { key: 'georgia', label: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
    { key: 'times', label: 'Times New Roman', css: '"Times New Roman", Times, serif' },
    { key: 'garamond', label: 'Garamond', css: 'Garamond, "Hoefler Text", "Times New Roman", serif' },
    { key: 'mono', label: 'Courier New', css: '"Courier New", Courier, monospace' }
  ];
  const fontByKey = (k) => FONTS.find((f) => f.key === k) || FONTS[0];
  const firstFamily = (css) => String(css || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();

  const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
  const LINE_HEIGHTS = [1, 1.15, 1.5, 2];
  const PAPER = { letter: { w: '8.5in', h: '11in', css: 'letter', label: 'Letter (8.5 × 11 in)' }, a4: { w: '210mm', h: '297mm', css: 'A4', label: 'A4 (210 × 297 mm)' } };
  const MARGINS = { narrow: { css: '0.5in', label: 'Narrow (0.5 in)' }, normal: { css: '1in', label: 'Normal (1 in)' }, wide: { css: '1.5in', label: 'Wide (1.5 in)' } };
  const DOC_DEFAULTS = { font: 'sans', size: 12, lineHeight: 1.5, paper: 'letter', margins: 'normal' };

  const PALETTE = [
    '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
    '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
    '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
    '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
    '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
    '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'
  ];

  const SYMBOLS = '© ® ™ § ¶ † ‡ • · … – — ‘ ’ “ ” « » ¿ ¡ ° ± × ÷ ≈ ≠ ≤ ≥ ∞ √ ∑ π µ Ω α β γ δ θ λ σ φ ½ ⅓ ¼ ¾ ¹ ² ³ € £ ¥ ¢ ₹ ← → ↑ ↓ ↔ ⇒ ✓ ✗ ★ ☆ ♥ ♦ ♣ ♠ ☐ ☑ ☺ ✉ ☎ ✂ ✎'.split(' ');

  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'UL', 'OL', 'TABLE', 'TR', 'HR']);
  const BLOCK_SEL = 'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th';
  const WORD_RE = /[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*/gu;

  /* =========================================================== settings */

  const SETTINGS_KEY = 'np.settings';
  const settings = Object.assign({
    theme: 'system', view: 'page', zoom: 1, sidebar: true, spellcheck: true, smartMd: true,
    voice: '', rate: 1, lastDoc: null, defaults: Object.assign({}, DOC_DEFAULTS)
  }, (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } })());

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode: settings last for this visit */ }
  }

  /* =========================================================== documents */

  let docs = [];           // every document record, newest first
  let current = null;      // the open document record
  let dirty = false;
  let saving = null;
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('notepad-online') : null;

  function newDocRecord(html = '', title = '') {
    const now = Date.now();
    return {
      id: uid(), title, titleAuto: !title, html, text: '', words: 0,
      created: now, updated: now, lastVersion: 0, goal: 0,
      settings: Object.assign({}, DOC_DEFAULTS, settings.defaults)
    };
  }

  function docSettings() {
    return Object.assign({}, DOC_DEFAULTS, current && current.settings);
  }

  function serialize() {
    return editor.innerHTML.replace(/ data-np-t="[^"]*"/g, '');
  }

  function autoTitle(text) {
    const line = (text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
    return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
  }

  function displayTitle(d) {
    return (d.titleAuto ? autoTitle(d.text) : d.title) || 'Untitled document';
  }

  function setStatus(text, kind) {
    const s = $('#save-status');
    s.textContent = text;
    s.dataset.kind = kind || '';
  }

  function markDirty() {
    if (!current) return;
    dirty = true;
    setStatus('Saving…', 'pending');
    scheduleSave();
  }

  const scheduleSave = debounce(() => saveNow(), 700);

  async function saveNow(reason) {
    if (!current) return;
    scheduleSave.cancel();
    if (saving) await saving;
    if (!dirty && !reason) return;
    const doc = current;
    const isPdf = doc.type === 'pdf';
    // A PDF's edits live on the record itself (NpPdf changes it in place).
    const html = isPdf ? '' : serialize();
    if (!isPdf) {
      const text = plainText();
      doc.html = html;
      doc.text = text.slice(0, 200000);
      doc.words = (text.match(WORD_RE) || []).length;
    }
    doc.updated = Date.now();
    dirty = false;
    saving = (async () => {
      try {
        await NpStore.putDoc(doc);
        if (!isPdf && (reason || doc.updated - (doc.lastVersion || 0) > 10 * 60 * 1000)) {
          await NpStore.addVersion(doc.id, html, displayTitle(doc), reason || 'Autosave');
          doc.lastVersion = doc.updated;
          await NpStore.putDoc(doc);
        }
        if (doc === current) setStatus(NpStore.persistent ? 'Saved' : 'Not saved — temporary', NpStore.persistent ? 'ok' : 'warn');
        if (channel) channel.postMessage({ type: 'saved', id: doc.id, updated: doc.updated });
        requestPersistence();
      } catch (e) {
        dirty = true;
        setStatus('Not saved', 'error');
        toast(/quota/i.test(String(e && e.name) + e) ? 'Storage is full. Download your work, then delete old documents or images.' : 'Could not save: ' + (e && e.message || e), 6000);
      }
    })();
    await saving;
    saving = null;
    sortDocs();
    renderDocList();
    updateTitle();
  }

  let persistAsked = false;
  function requestPersistence() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }

  function sortDocs() {
    docs.sort((a, b) => b.updated - a.updated);
  }

  async function openDoc(id, opts = {}) {
    if (current && current.id === id && !opts.force) return;
    if (current && dirty) await saveNow();
    const doc = docs.find((d) => d.id === id) || (await NpStore.getDoc(id));
    if (!doc) return;
    if (!docs.includes(doc)) docs.push(doc);
    closeFind();
    hideImageFrame();
    stopSpeaking();
    current = doc;
    current.settings = Object.assign({}, DOC_DEFAULTS, current.settings);
    const mobile = matchMedia('(max-width: 899px)').matches;
    document.body.classList.toggle('pdf-mode', doc.type === 'pdf');
    if (doc.type === 'pdf') {
      dirty = false;
      settings.lastDoc = doc.id;
      saveSettings();
      updateTitle();
      renderDocList();
      setStatus(NpStore.persistent ? 'Saved' : 'Not saved — temporary', NpStore.persistent ? 'ok' : 'warn');
      if (mobile) setSidebar(false, true);
      await NpPdf.open(doc);
      return;
    }
    if (NpPdf.active) NpPdf.close();
    setZoom(settings.zoom);
    editor.innerHTML = NpSanitize.html(doc.html || '');
    if (!editor.firstChild) editor.innerHTML = '<p><br></p>';
    dirty = false;
    settings.lastDoc = doc.id;
    saveSettings();
    applyDocSettings();
    updateTitle();
    renderDocList();
    refreshMetrics();
    setStatus(NpStore.persistent ? 'Saved' : 'Not saved — temporary', NpStore.persistent ? 'ok' : 'warn');
    workspace.scrollTop = 0;
    if (!opts.noFocus && !matchMedia('(max-width: 899px)').matches) placeCaretAtStart();
    if (matchMedia('(max-width: 899px)').matches) setSidebar(false, true);
  }

  function placeCaretAtStart() {
    editor.focus({ preventScroll: true });
    const r = document.createRange();
    r.setStart(editor, 0);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  // A blank, untouched document is replaced rather than left behind.
  async function dropBlankCurrent() {
    const blank = current && current.type !== 'pdf' && !current.title && !current.goal && !(current.html || '').replace(/<p><br><\/p>|<br>/g, '').trim() && isEmptyDoc();
    if (!blank) return;
    const old = current;
    await NpStore.deleteDoc(old.id).catch(() => {});
    docs = docs.filter((d) => d !== old);
    current = null;
  }

  async function addRecord(doc) {
    try { await NpStore.putDoc(doc); } catch (e) { toast(/quota/i.test(String(e && e.name) + e) ? 'There is not enough storage space for that file.' : 'Could not create the document: ' + e.message); return null; }
    docs.unshift(doc);
    await openDoc(doc.id, { force: true });
    return doc;
  }

  async function createPdfDoc(file, name) {
    const buf = await file.arrayBuffer();
    setStatus('Opening PDF…', 'pending');
    const info = await NpPdf.newRecord(buf);
    if (current && dirty) await saveNow();
    await dropBlankCurrent();
    const doc = Object.assign(newDocRecord('', name), { type: 'pdf', titleAuto: false, sources: [buf], pages: info.pages, pageCount: info.pages.length, items: [], fields: {}, text: info.text });
    return addRecord(doc);
  }

  async function createDoc(html = '', title = '', opts = {}) {
    if (current && dirty) await saveNow();
    await dropBlankCurrent();
    const doc = newDocRecord(html, title);
    if (opts.settings) Object.assign(doc.settings, opts.settings);
    const tmp = document.createElement('div');
    tmp.innerHTML = html.replace(/<\/(p|h[1-6]|li|div|pre|blockquote|tr)>/g, '$&\n');
    doc.text = tmp.textContent || '';
    doc.words = (doc.text.match(WORD_RE) || []).length;
    try { await NpStore.putDoc(doc); } catch (e) { toast('Could not create the document: ' + e.message); return null; }
    docs.unshift(doc);
    await openDoc(doc.id, { force: true });
    if (!opts.keepFocus) setTimeout(placeCaretAtStart, 0);
    return doc;
  }

  async function deleteDoc(id) {
    const doc = docs.find((d) => d.id === id);
    if (!doc) return;
    const ok = await confirmDialog('Delete “' + displayTitle(doc) + '”?', 'The document and its version history are removed from this browser. This cannot be undone.', { ok: 'Delete', danger: true });
    if (!ok) return;
    await NpStore.deleteDoc(id);
    docs = docs.filter((d) => d.id !== id);
    if (channel) channel.postMessage({ type: 'deleted', id });
    if (current && current.id === id) {
      current = null;
      dirty = false;
      if (docs.length) await openDoc(docs[0].id, { force: true });
      else await createDoc();
    } else {
      renderDocList();
    }
    toast('Document deleted');
  }

  function updateTitle() {
    if (!current) return;
    const t = displayTitle(current);
    if (document.activeElement !== titleInput) titleInput.value = current.titleAuto ? (autoTitle(current.text) || '') : current.title;
    document.title = t + ' — Notepad Online';
  }

  titleInput.addEventListener('input', () => {
    if (!current) return;
    const v = titleInput.value.trim();
    current.title = v;
    current.titleAuto = !v;
    markDirty();
    document.title = displayTitle(current) + ' — Notepad Online';
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); placeCaretAtStart(); }
  });
  titleInput.addEventListener('blur', () => updateTitle());

  if (channel) {
    channel.onmessage = async (e) => {
      const m = e.data || {};
      if (m.type === 'saved') {
        const fresh = await NpStore.getDoc(m.id);
        if (!fresh) return;
        const i = docs.findIndex((d) => d.id === m.id);
        if (current && current.id === m.id) {
          if (dirty || fresh.updated <= current.updated || fresh.type === 'pdf') return;
          Object.assign(current, fresh);
          editor.innerHTML = NpSanitize.html(fresh.html);
          applyDocSettings();
          refreshMetrics();
          updateTitle();
          toast('Updated from another tab');
        } else if (i >= 0) docs[i] = fresh;
        else docs.push(fresh);
        sortDocs();
        renderDocList();
      } else if (m.type === 'deleted') {
        docs = docs.filter((d) => d.id !== m.id);
        if (current && current.id === m.id) {
          current = null;
          if (docs.length) openDoc(docs[0].id, { force: true }); else createDoc();
          toast('This document was deleted in another tab');
        } else renderDocList();
      }
    };
  }

  /* =========================================================== editor core */

  let savedRange = null;
  let plainPasteNext = false;
  let pendingFontSize = null;

  document.execCommand('styleWithCSS', false, true);
  document.execCommand('defaultParagraphSeparator', false, 'p');

  function selectionInEditor() {
    const s = getSelection();
    return s.rangeCount > 0 && editor.contains(s.getRangeAt(0).commonAncestorContainer);
  }

  // The live selection when it is in the document, else the last one seen
  // there (selectionchange arrives late, so the live one wins).
  function currentRange() {
    if (selectionInEditor()) return getSelection().getRangeAt(0).cloneRange();
    return savedRange ? savedRange.cloneRange() : null;
  }

  function restoreSelection() {
    if (document.activeElement === editor && selectionInEditor()) return;
    editor.focus({ preventScroll: true });
    if (savedRange && editor.contains(savedRange.commonAncestorContainer)) {
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(savedRange);
    }
  }

  function exec(cmd, value = null) {
    restoreSelection();
    const ok = document.execCommand(cmd, false, value);
    afterEdit();
    return ok;
  }

  function afterEdit() {
    markDirty();
    scheduleMetrics();
    updateToolbarState();
    if (findState.open) scheduleFind();
  }

  function selectNode(node, contents) {
    const r = document.createRange();
    if (contents) r.selectNodeContents(node); else r.selectNode(node);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return r;
  }

  function caretTo(node, atEnd) {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(!atEnd);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  // Replace a node through execCommand so Undo can take it back.
  function replaceUndoable(node, html, focusSel) {
    editor.focus({ preventScroll: true });
    const top = workspace.scrollTop;
    selectNode(node);
    document.execCommand('insertHTML', false, html);
    workspace.scrollTop = top;
    const target = focusSel ? editor.querySelector(focusSel) : null;
    // Chrome copies attributes onto paragraphs split off with Enter, so the
    // marker must not outlive this lookup.
    if (target) target.removeAttribute('data-np-t');
    afterEdit();
    return target;
  }

  function currentNode() {
    const s = getSelection();
    if (!s.rangeCount) return null;
    let n = s.getRangeAt(0).startContainer;
    if (n.nodeType === 3) n = n.parentNode;
    if (n.nodeType === 1 && n.childNodes.length && s.getRangeAt(0).startContainer === n) {
      const child = n.childNodes[Math.min(s.getRangeAt(0).startOffset, n.childNodes.length - 1)];
      if (child && child.nodeType === 1) n = child;
    }
    return editor.contains(n) ? n : null;
  }

  function closestInEditor(sel) {
    const n = currentNode();
    const found = n && n.closest(sel);
    return found && editor.contains(found) && found !== editor ? found : null;
  }

  function blockOf(node) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== editor) {
      if (n.nodeType === 1 && n.matches(BLOCK_SEL)) return n;
      n = n.parentNode;
    }
    return editor;
  }

  // Text with a newline between blocks, and a map back to DOM positions.
  function textIndex(markers) {
    const segs = [];
    let text = '';
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) {
        if (n.tagName === 'BR' || n.tagName === 'IMG' || n.tagName === 'HR') text += '\n';
        else if (BLOCK_TAGS.has(n.tagName) && text && !text.endsWith('\n')) text += '\n';
        if (markers && n.tagName === 'LI') text += listMarker(n);
        continue;
      }
      const v = n.nodeValue;
      if (!v) continue;
      segs.push({ node: n, start: text.length, end: text.length + v.length });
      text += v;
    }
    function locate(pos, preferEnd) {
      let lo = 0;
      let hi = segs.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = segs[mid];
        if (pos < s.start) hi = mid - 1;
        else if (pos > s.end || (pos === s.end && !preferEnd && mid < segs.length - 1 && segs[mid + 1].start === pos)) lo = mid + 1;
        else return { node: s.node, offset: pos - s.start };
      }
      const s = segs[clamp(lo, 0, segs.length - 1)];
      return s ? { node: s.node, offset: clamp(pos - s.start, 0, s.node.nodeValue.length) } : null;
    }
    return {
      text,
      range(a, b) {
        const s = locate(a, false);
        const e = locate(b, true);
        if (!s || !e) return null;
        const r = document.createRange();
        r.setStart(s.node, s.offset);
        r.setEnd(e.node, e.offset);
        return r;
      }
    };
  }

  // "• ", "3. " or "[x] ", indented by nesting: list markers for plain-text export.
  function listMarker(li) {
    const list = li.parentElement;
    let depth = 0;
    for (let p = list && list.parentElement; p && p !== editor; p = p.parentElement) if (p.tagName === 'UL' || p.tagName === 'OL') depth++;
    const pad = '  '.repeat(depth);
    if (!list) return '';
    if (list.classList.contains('checklist')) return pad + (li.getAttribute('data-checked') === 'true' ? '[x] ' : '[ ] ');
    if (list.tagName === 'OL') {
      const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
      return pad + ((parseInt(list.getAttribute('start'), 10) || 1) + items.indexOf(li)) + '. ';
    }
    return pad + '• ';
  }

  function plainText() {
    return textIndex().text.replace(/\n{3,}/g, '\n\n').trim();
  }

  function isEmptyDoc() {
    return !editor.textContent.trim() && !editor.querySelector('img,table,hr,li');
  }

  /* ----- input ----- */

  editor.addEventListener('input', (e) => {
    editor.classList.toggle('is-empty', isEmptyDoc());
    if (settings.smartMd && e.inputType === 'insertText' && e.data === ' ') markdownShortcut();
    if (pendingFontSize) applyPendingFontSize();
    afterEdit();
    positionImageFrame();
  });

  editor.addEventListener('beforeinput', (e) => {
    // Typing over a selected image replaces it, as in any word processor.
    if (selectedImage && e.inputType.startsWith('insert')) hideImageFrame();
  });

  function markdownShortcut() {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return;
    const r = s.getRangeAt(0);
    if (r.startContainer.nodeType !== 3) return;
    const block = blockOf(r.startContainer);
    if (block !== editor && block.closest('pre,td,th,li')) return;
    const pre = document.createRange();
    pre.setStart(block, 0);
    pre.setEnd(r.startContainer, r.startOffset);
    const before = pre.toString().replace(/ /g, ' ');
    const m = before.match(/^(#{1,3}|[-*+]|1[.)]|>|\[[ xX]?\]|```) $/);
    if (!m) return;
    const tok = m[1];
    s.removeAllRanges();
    s.addRange(pre);
    document.execCommand('delete');
    if (tok[0] === '#') document.execCommand('formatBlock', false, '<h' + tok.length + '>');
    else if (tok === '>') document.execCommand('formatBlock', false, '<blockquote>');
    else if (tok === '```') document.execCommand('formatBlock', false, '<pre>');
    else if (/^1/.test(tok)) blockToList('ol');
    else if (tok[0] === '[') blockToList('checklist', /x/i.test(tok));
    else blockToList('ul');
    fixListInParagraph();
  }

  // Turn the paragraph the caret is in into a new list. Done with insertHTML
  // rather than the list commands, which merge into a list just above.
  function blockToList(kind, checked) {
    const block = blockOf(currentNode());
    const s = getSelection();
    const multi = s.rangeCount && !s.isCollapsed && blockOf(s.getRangeAt(0).endContainer) !== block;
    if (!block || block === editor || multi || !/^(P|DIV|H[1-6])$/.test(block.tagName)) {
      document.execCommand(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
      fixListInParagraph();
      if (kind === 'checklist') markChecklist(closestInEditor('ul'), checked);
      return;
    }
    const tok = uid();
    const open = kind === 'ol' ? '<ol>' : kind === 'checklist' ? '<ul class="checklist">' : '<ul>';
    const close = kind === 'ol' ? '</ol>' : '</ul>';
    const attr = kind === 'checklist' ? ' data-checked="' + (checked ? 'true' : 'false') + '"' : '';
    const inner = block.innerHTML.trim() || '<br>';
    const li = replaceUndoable(block, open + '<li' + attr + ' data-np-t="' + tok + '">' + inner + '</li>' + close, '[data-np-t="' + tok + '"]');
    if (li) caretTo(li, true);
  }

  function markChecklist(list, checked) {
    if (!list) return;
    list.classList.add('checklist');
    for (const item of list.children) if (item.tagName === 'LI' && !item.hasAttribute('data-checked')) item.setAttribute('data-checked', checked ? 'true' : 'false');
  }

  // Chrome wraps a new list in the paragraph it came from (<p><ul>…</ul></p>).
  function fixListInParagraph() {
    for (const list of $$('p > ul, p > ol', editor)) {
      const p = list.parentElement;
      if (p.childNodes.length === 1) p.replaceWith(list);
    }
  }

  editor.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      if (mod(e)) { e.preventDefault(); insertPageBreak(); return; }
      if (handleEnter(e)) return;
    }
    if (e.key === 'Tab' && !mod(e) && !e.altKey) {
      const cell = closestInEditor('td,th');
      if (cell) { e.preventDefault(); moveCell(cell, e.shiftKey ? -1 : 1); return; }
      if (closestInEditor('li')) { e.preventDefault(); exec(e.shiftKey ? 'outdent' : 'indent'); return; }
      if (!e.shiftKey) { e.preventDefault(); exec('insertText', '\t'); return; }
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedImage) {
      e.preventDefault();
      const img = selectedImage;
      hideImageFrame();
      selectNode(img);
      exec('delete');
      return;
    }
    if (mod(e) && e.shiftKey && (e.key === 'v' || e.key === 'V')) plainPasteNext = true;
  });

  function handleEnter(e) {
    const block = blockOf(currentNode());
    if (block && block !== editor && settings.smartMd) {
      const t = block.textContent.replace(/ /g, ' ').trim();
      if ((t === '---' || t === '***' || t === '___') && !block.closest('pre,td,th,li')) {
        e.preventDefault();
        selectNode(block, true);
        document.execCommand('delete');
        insertRule('');
        return true;
      }
    }
    // Enter on an empty last line leaves a code block or quote.
    const pre = closestInEditor('pre');
    if (pre && caretAtEnd(pre)) {
      if (!pre.textContent) { e.preventDefault(); exec('formatBlock', '<p>'); return true; }
      const kids = pre.childNodes;
      const n = kids.length;
      if (n >= 2 && kids[n - 1].nodeName === 'BR' && kids[n - 2].nodeName === 'BR') {
        e.preventDefault();
        const r = document.createRange();
        r.setStartBefore(kids[n - 2]);
        r.setEndAfter(kids[n - 1]);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        document.execCommand('delete');
        exitAfter(pre);
        return true;
      }
    }
    const quote = closestInEditor('blockquote');
    if (quote && !NpSanitize.isIndentQuote(quote) && caretAtEnd(quote)) {
      const emptyLine = (n) => !n.textContent.trim() && !n.querySelector('img');
      if (block === quote && emptyLine(quote)) { e.preventDefault(); exec('formatBlock', '<p>'); return true; }
      const last = quote.lastElementChild;
      if (last && last === block && emptyLine(last) && quote.children.length > 1) {
        e.preventDefault();
        last.remove();
        exitAfter(quote);
        return true;
      }
    }
    return false;
  }

  function exitAfter(node) {
    const p = document.createElement('p');
    p.innerHTML = '<br>';
    node.after(p);
    caretTo(p);
    afterEdit();
  }

  function caretAtEnd(node) {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return false;
    const r = document.createRange();
    r.selectNodeContents(node);
    r.setStart(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset);
    return !r.toString().length && !r.cloneContents().querySelector('img');
  }

  function lastLineText(pre) {
    // text after the last <br>: empty means the caret sits on a blank line
    const html = pre.innerHTML.replace(/<br>\s*$/i, '');
    const after = html.split(/<br>/i).pop();
    return after.replace(/<[^>]+>/g, '').trim() ? 'x' : '';
  }

  /* ----- clicks inside the document ----- */

  editor.addEventListener('mousedown', (e) => {
    const li = e.target.closest && e.target.closest('ul.checklist > li');
    if (li && e.target === li) {
      const rect = li.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(li).paddingLeft) || 24;
      if (e.clientX - rect.left < pad * (rect.width / li.offsetWidth || 1)) {
        e.preventDefault();
        li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
        afterEdit();
      }
    }
  });

  editor.addEventListener('click', (e) => {
    const img = e.target.closest && e.target.closest('img');
    if (img && editor.contains(img)) { selectImage(img); return; }
    hideImageFrame();
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && (mod(e) || !editor.isContentEditable)) {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    }
  });

  /* ----- clipboard ----- */

  function clipboardHtmlOfSelection() {
    const s = getSelection();
    const r = s.getRangeAt(0);
    let wrap = document.createElement('div');
    wrap.appendChild(r.cloneContents());
    // keep inline formatting the selection sits inside (bold, color…)
    let n = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer;
    while (n && n !== editor && !n.matches(BLOCK_SEL)) {
      const shell = n.cloneNode(false);
      while (wrap.firstChild) shell.appendChild(wrap.firstChild);
      wrap = document.createElement('div');
      wrap.appendChild(shell);
      n = n.parentNode;
    }
    return wrap.innerHTML.replace(/ data-np-t="[^"]*"/g, '');
  }

  function onCopy(e, cut) {
    const s = getSelection();
    if (!s.rangeCount || s.isCollapsed || !selectionInEditor() || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/html', '<meta name="np-clip" content="1">' + clipboardHtmlOfSelection());
    e.clipboardData.setData('text/plain', s.toString());
    if (cut) exec('delete');
  }
  editor.addEventListener('copy', (e) => onCopy(e, false));
  editor.addEventListener('cut', (e) => onCopy(e, true));

  editor.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = Array.from(cd.files || []).filter((f) => f.type.startsWith('image/'));
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    e.preventDefault();
    const plain = plainPasteNext;
    plainPasteNext = false;
    if (files.length && !html) { files.forEach(insertImageFile); return; }
    if (closestInEditor('pre') || plain || !html) { if (text) exec('insertText', text); return; }
    const internal = /name="np-clip"/.test(html);
    const clean = NpSanitize.html(html, { external: !internal });
    if (clean.trim()) exec('insertHTML', clean);
    else if (text) exec('insertText', text);
    fixListInParagraph();
  });

  /* ----- drag and drop ----- */

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('#drop-hint').hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-hint').hidden = true;
    const files = Array.from(e.dataTransfer.files);
    const images = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    if (images.length) {
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (r && editor.contains(r.startContainer)) { editor.focus(); getSelection().removeAllRanges(); getSelection().addRange(r); savedRange = r; }
      }
      images.forEach(insertImageFile);
    }
    if (others.length) openFiles(others);
  });

  /* ----- selection tracking ----- */

  document.addEventListener('selectionchange', () => {
    if (!selectionInEditor()) return;
    savedRange = getSelection().getRangeAt(0).cloneRange();
    updateToolbarStateSoon();
    updateSelectionCount();
  });

  /* =========================================================== commands */

  function setBlock(tag) {
    restoreSelection();
    const inList = closestInEditor('li');
    if (inList && tag !== 'p') {
      const list = inList.closest('ul,ol');
      document.execCommand(list.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
    }
    const cur = blockOf(currentNode());
    if (cur && cur !== editor && cur.tagName.toLowerCase() === tag && tag !== 'p') tag = 'p';
    exec('formatBlock', '<' + tag + '>');
  }

  function makeChecklist(checked) {
    const li = closestInEditor('li');
    const list = li && li.closest('ul,ol');
    if (list && list.classList.contains('checklist')) { document.execCommand('insertUnorderedList'); return; }
    if (list && list.tagName === 'UL') { markChecklist(list, checked); return; }
    if (list) document.execCommand('insertOrderedList');
    blockToList('checklist', checked);
  }

  function toggleChecklist() {
    restoreSelection();
    makeChecklist(false);
    afterEdit();
  }

  function applyFontSize(pt) {
    restoreSelection();
    const s = getSelection();
    if (!s.rangeCount) return;
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    document.execCommand('styleWithCSS', false, true);
    if (s.isCollapsed) pendingFontSize = pt;
    else for (const f of $$('font[size="7"]', editor)) { f.removeAttribute('size'); f.style.fontSize = pt + 'pt'; }
    afterEdit();
  }

  function applyPendingFontSize() {
    for (const f of $$('font[size="7"]', editor)) { f.removeAttribute('size'); f.style.fontSize = pendingFontSize + 'pt'; }
    pendingFontSize = null;
  }

  function applyFont(key) {
    exec('fontName', fontByKey(key).css);
  }

  function setColor(kind, color) {
    if (kind === 'fore') exec('foreColor', color || 'inherit');
    else exec('hiliteColor', color || 'transparent');
    if (color) {
      settings[kind === 'fore' ? 'lastFore' : 'lastBack'] = color;
      saveSettings();
      paintColorBars();
    }
  }

  function paintColorBars() {
    $('#fore-bar').style.background = settings.lastFore || 'currentColor';
    $('#back-bar').style.background = settings.lastBack || '#fff2cc';
  }

  function clearFormatting() {
    restoreSelection();
    document.execCommand('removeFormat');
    document.execCommand('unlink');
    const block = blockOf(currentNode());
    if (block && block !== editor && /^(H[1-6]|BLOCKQUOTE|PRE)$/.test(block.tagName)) document.execCommand('formatBlock', false, '<p>');
    afterEdit();
  }

  function toggleInlineCode() {
    restoreSelection();
    const code = closestInEditor('code');
    if (code) {
      replaceUndoable(code, escapeHtml(code.textContent));
      return;
    }
    const s = getSelection();
    const text = s.toString();
    if (!text) { exec('insertHTML', '<code>​</code>'); return; }
    exec('insertHTML', '<code>' + escapeHtml(text) + '</code>');
  }

  // insertHorizontalRule writes id="null" and leaves the caret outside any
  // paragraph, so lines are inserted as HTML with a paragraph after them.
  function insertRule(cls) {
    const tok = uid();
    exec('insertHTML', '<hr' + (cls ? ' class="' + cls + '"' : '') + '><p data-np-t="' + tok + '"><br></p>');
    const p = editor.querySelector('[data-np-t="' + tok + '"]');
    if (p) { p.removeAttribute('data-np-t'); caretTo(p); }
  }

  function insertPageBreak() {
    insertRule('page-break');
  }

  function insertDate() {
    exec('insertText', new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
  }

  /* =========================================================== toolbar */

  const tbBlock = $('#tb-block');
  const tbFont = $('#tb-font');
  const tbSize = $('#tb-size');

  function buildToolbar() {
    tbFont.innerHTML = FONTS.map((f) => '<option value="' + f.key + '" style="font-family:' + escapeHtml(f.css) + '">' + escapeHtml(f.label) + '</option>').join('') + '<option value="" hidden id="tb-font-other">Other</option>';
    tbSize.innerHTML = SIZES.map((s) => '<option value="' + s + '">' + s + '</option>').join('') + '<option value="" hidden id="tb-size-other"></option>';
    tbBlock.addEventListener('change', () => { setBlock(tbBlock.value); });
    tbFont.addEventListener('change', () => { if (tbFont.value) applyFont(tbFont.value); });
    tbSize.addEventListener('change', () => { if (tbSize.value) applyFontSize(+tbSize.value); });
    // Toolbar buttons must not take focus from the document, or the selection goes with it.
    $('#toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    $('#ctxbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    for (const tb of [$('#toolbar'), $('#pdf-toolbar')]) {
      const edges = () => {
        tb.classList.toggle('more-left', tb.scrollLeft > 2);
        tb.classList.toggle('more-right', tb.scrollLeft + tb.clientWidth < tb.scrollWidth - 2);
      };
      tb.addEventListener('scroll', edges, { passive: true });
      window.addEventListener('resize', edges);
      new ResizeObserver(edges).observe(tb);
    }
    paintColorBars();
  }

  let stateRaf = 0;
  function updateToolbarStateSoon() {
    if (stateRaf) return;
    stateRaf = requestAnimationFrame(() => { stateRaf = 0; updateToolbarState(); updateCtxBar(); });
  }

  function updateToolbarState() {
    if (!selectionInEditor()) return;
    for (const b of $$('[data-state]')) {
      const cmd = b.dataset.state;
      let on = false;
      if (cmd === 'checklist') on = !!closestInEditor('ul.checklist');
      else if (cmd === 'insertUnorderedList') on = !!closestInEditor('ul') && !closestInEditor('ul.checklist');
      else { try { on = document.queryCommandState(cmd); } catch (e) { on = false; } }
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const n = currentNode() || editor;
    const block = blockOf(n);
    const tag = block && block !== editor ? block.tagName.toLowerCase() : 'p';
    const bq = closestInEditor('blockquote');
    tbBlock.value = closestInEditor('pre') ? 'pre' : /^h[1-3]$/.test(tag) ? tag : bq && !NpSanitize.isIndentQuote(bq) ? 'blockquote' : 'p';
    const cs = getComputedStyle(n.nodeType === 1 ? n : n.parentElement);
    const fam = firstFamily(cs.fontFamily);
    const f = FONTS.find((x) => firstFamily(x.css) === fam);
    if (f) tbFont.value = f.key;
    else { $('#tb-font-other').textContent = cs.fontFamily.split(',')[0].replace(/["']/g, ''); tbFont.value = ''; }
    const pt = Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2;
    if (SIZES.includes(pt)) tbSize.value = String(pt);
    else { $('#tb-size-other').textContent = String(pt); tbSize.value = ''; }
  }

  /* ----- context bar: image / link / table tools ----- */

  function ctxButton(icon, label, fn, extra) {
    return el('button', Object.assign({ class: 'ctx-btn', type: 'button', title: label, 'aria-label': label, 'data-icon': icon || null, onclick: fn }, extra || {}), icon ? null : label);
  }

  function updateCtxBar() {
    const bar = $('#ctxbar');
    let content = null;
    if (selectedImage && editor.contains(selectedImage)) {
      const img = selectedImage;
      const w = img.style.width;
      const size = (label, val) => el('button', { class: 'ctx-btn text' + (w === val ? ' on' : ''), type: 'button', onclick: () => setImage(img, (c) => { if (val) c.style.width = val; else c.style.removeProperty('width'); if (!c.getAttribute('style')) c.removeAttribute('style'); }) }, label);
      const align = (icon, label, cls) => ctxButton(icon, label, () => setImage(img, (c) => { c.classList.remove('img-left', 'img-center', 'img-right'); if (cls) c.classList.add(cls); if (!c.className) c.removeAttribute('class'); }), { class: 'ctx-btn' + ((cls ? img.classList.contains(cls) : !/img-/.test(img.className)) ? ' on' : '') });
      content = [
        el('span', { class: 'ctx-label' }, 'Image'),
        size('25%', '25%'), size('50%', '50%'), size('75%', '75%'), size('Full', '100%'), size('Original', ''),
        el('span', { class: 'tb-sep' }),
        align('alignLeft', 'Inline with text', ''), align('alignCenter', 'Center', 'img-center'),
        el('button', { class: 'ctx-btn text' + (img.classList.contains('img-left') ? ' on' : ''), type: 'button', title: 'Wrap text, image on the left', onclick: () => setImage(img, (c) => { c.classList.remove('img-center', 'img-right'); c.classList.add('img-left'); }) }, 'Wrap left'),
        el('button', { class: 'ctx-btn text' + (img.classList.contains('img-right') ? ' on' : ''), type: 'button', title: 'Wrap text, image on the right', onclick: () => setImage(img, (c) => { c.classList.remove('img-center', 'img-left'); c.classList.add('img-right'); }) }, 'Wrap right'),
        el('span', { class: 'tb-sep' }),
        el('button', { class: 'ctx-btn text', type: 'button', onclick: () => editAlt(img) }, 'Alt text'),
        ctxButton('trash', 'Delete image', () => { hideImageFrame(); selectNode(img); exec('delete'); })
      ];
    } else {
      const a = closestInEditor('a[href]');
      const cell = closestInEditor('td,th');
      if (a) {
        content = [
          el('span', { class: 'ctx-label' }, 'Link'),
          el('a', { class: 'ctx-url', href: a.href, target: '_blank', rel: 'noopener', title: a.href }, a.getAttribute('href')),
          ctxButton('external', 'Open link', () => window.open(a.href, '_blank', 'noopener')),
          ctxButton('edit', 'Edit link', () => linkDialog(a)),
          ctxButton('unlink', 'Remove link', () => { selectNode(a, true); exec('unlink'); })
        ];
      } else if (cell) {
        content = [
          el('span', { class: 'ctx-label' }, 'Table'),
          ctxButton('rowAbove', 'Insert row above', () => tableOp('row-above')),
          ctxButton('rowBelow', 'Insert row below', () => tableOp('row-below')),
          ctxButton('colLeft', 'Insert column left', () => tableOp('col-left')),
          ctxButton('colRight', 'Insert column right', () => tableOp('col-right')),
          el('span', { class: 'tb-sep' }),
          ctxButton('delRow', 'Delete row', () => tableOp('del-row')),
          ctxButton('delCol', 'Delete column', () => tableOp('del-col')),
          ctxButton('header', 'Header row on or off', () => tableOp('header'), { class: 'ctx-btn' + (cell.closest('table').rows[0] && cell.closest('table').rows[0].cells[0] && cell.closest('table').rows[0].cells[0].tagName === 'TH' ? ' on' : '') }),
          el('span', { class: 'tb-sep' }),
          ctxButton('trash', 'Delete table', () => tableOp('del-table'))
        ];
      }
    }
    if (!content) { bar.hidden = true; bar.replaceChildren(); return; }
    bar.replaceChildren(...content);
    NpIcons.inject(bar);
    bar.hidden = false;
  }

  /* =========================================================== menus */

  const menubar = $('#menubar');
  let openMenu = null;

  function closeMenus() {
    if (!openMenu) return;
    openMenu.classList.remove('open');
    openMenu.querySelector('.menu-btn').setAttribute('aria-expanded', 'false');
    openMenu = null;
  }

  function openMenuEl(m, focusFirst) {
    closeMenus();
    closePopover();
    refreshMenuChecks();
    m.classList.add('open');
    m.querySelector('.menu-btn').setAttribute('aria-expanded', 'true');
    openMenu = m;
    const pop = m.querySelector('.menu-pop');
    pop.style.left = '';
    const r = pop.getBoundingClientRect();
    if (r.right > innerWidth - 8) pop.style.left = Math.min(0, innerWidth - 8 - r.right) + 'px';
    if (focusFirst) pop.querySelector('button').focus();
  }

  menubar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  menubar.addEventListener('click', (e) => {
    const btn = e.target.closest('.menu-btn');
    if (!btn) return;
    const m = btn.parentElement;
    if (openMenu === m) closeMenus(); else openMenuEl(m, e.detail === 0);
  });
  menubar.addEventListener('mouseover', (e) => {
    if (!openMenu) return;
    const btn = e.target.closest('.menu-btn');
    if (btn && btn.parentElement !== openMenu) openMenuEl(btn.parentElement);
  });
  menubar.addEventListener('keydown', (e) => {
    const menus = $$('.menu', menubar);
    const m = e.target.closest('.menu');
    if (!m) return;
    const i = menus.indexOf(m);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = menus[(i + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length];
      if (openMenu) openMenuEl(next, true); else next.querySelector('.menu-btn').focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!openMenu) { openMenuEl(m, true); return; }
      const items = $$('.menu-pop > button', m);
      const j = items.indexOf(document.activeElement);
      const k = e.key === 'ArrowDown' ? (j + 1) % items.length : (j - 1 + items.length) % items.length;
      items[k].focus();
    } else if (e.key === 'Escape' && openMenu) {
      e.preventDefault();
      const b = openMenu.querySelector('.menu-btn');
      closeMenus();
      b.focus();
    }
  });

  function refreshMenuChecks() {
    const state = {
      'view:page': settings.view === 'page', 'view:full': settings.view === 'full',
      'theme:light': settings.theme === 'light', 'theme:dark': settings.theme === 'dark', 'theme:system': settings.theme === 'system',
      sidebar: document.body.classList.contains('sidebar-open'),
      spellcheck: settings.spellcheck, smartMd: settings.smartMd
    };
    for (const b of $$('[data-check]')) {
      const on = !!state[b.dataset.check];
      b.classList.toggle('checked', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  document.addEventListener('mousedown', (e) => {
    if (openMenu && !e.target.closest('.menu')) closeMenus();
    if (popover.open && !e.target.closest('#popover') && !e.target.closest('[data-popover-anchor]')) closePopover();
  });

  /* =========================================================== actions */

  const pdfMode = () => !!current && current.type === 'pdf';

  async function downloadPdf() {
    NpPdf.finishEditing();
    await saveNow();
    setStatus('Preparing PDF…', 'pending');
    try {
      const blob = await NpPdf.export(current);
      download(blob, safeFileName(displayTitle(current), 'pdf'));
    } catch (e) {
      toast('Could not make the PDF: ' + (e.message || e), 7000);
    }
    setStatus('Saved', 'ok');
  }

  async function printPdf() {
    NpPdf.finishEditing();
    const w = window.open('', '_blank');
    try {
      const blob = await NpPdf.export(current);
      const url = URL.createObjectURL(blob);
      if (w) { w.location.href = url; toast('Your PDF opened in a new tab. Print it from there.', 4000); }
      else download(blob, safeFileName(displayTitle(current), 'pdf'));
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (e) {
      if (w) w.close();
      toast('Could not make the PDF: ' + (e.message || e), 7000);
    }
  }

  const ACTIONS = {
    'new': () => createDoc(),
    open: () => $('#file-open').click(),
    duplicate: duplicateDoc,
    rename: () => { titleInput.focus(); titleInput.select(); },
    history: historyDialog,
    'export': (arg) => (pdfMode() ? downloadPdf() : exportAs(arg)),
    print: () => (pdfMode() ? printPdf() : printDoc()),
    'page-setup': pageSetupDialog,
    backup: backupAll,
    'restore-backup': () => $('#file-backup').click(),
    'delete': () => current && deleteDoc(current.id),
    cmd: (arg) => {
      if (pdfMode()) { if (arg === 'undo') NpPdf.undo(); if (arg === 'redo') NpPdf.redo(); return; }
      exec(arg);
      if (arg === 'insertUnorderedList' || arg === 'insertOrderedList') {
        const ul = closestInEditor('ul.checklist');
        if (arg === 'insertUnorderedList' && ul) ul.classList.remove('checklist');
        fixListInParagraph();
      }
    },
    'select-all': () => { editor.focus(); selectNode(editor, true); },
    find: () => openFind(false),
    replace: () => openFind(true),
    image: () => $('#file-image').click(),
    'image-url': imageUrlDialog,
    'table-menu': (arg, btn) => tablePicker(btn),
    link: () => linkDialog(closestInEditor('a[href]')),
    checklist: toggleChecklist,
    'page-break': insertPageBreak,
    hr: () => insertRule(''),
    date: insertDate,
    symbols: (arg, btn) => symbolPicker(btn),
    block: (arg) => setBlock(arg),
    'inline-code': toggleInlineCode,
    'clear-format': clearFormatting,
    'color-menu': (arg, btn) => colorPicker(arg, btn),
    view: (arg) => setView(arg),
    theme: (arg) => setTheme(arg),
    'toggle-theme': () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'),
    zoom: (arg) => pdfMode() ? NpPdf.zoom(arg || 'reset') : setZoom(arg === 'in' ? settings.zoom + 0.1 : arg === 'out' ? settings.zoom - 0.1 : 1),
    'toggle-sidebar': () => setSidebar(!document.body.classList.contains('sidebar-open')),
    focus: toggleFocus,
    'word-count': wordCountDialog,
    goal: goalDialog,
    speak: toggleSpeak,
    voice: voiceDialog,
    spellcheck: () => { settings.spellcheck = !settings.spellcheck; saveSettings(); applySpellcheck(); toast('Spell check ' + (settings.spellcheck ? 'on' : 'off')); },
    'smart-md': () => { settings.smartMd = !settings.smartMd; saveSettings(); toast('Markdown shortcuts ' + (settings.smartMd ? 'on' : 'off')); },
    shortcuts: shortcutsDialog,
    about: aboutDialog,
    'find-next': () => findStep(1),
    'find-prev': () => findStep(-1),
    'find-close': () => closeFind(true),
    'replace-one': replaceOne,
    'replace-all': replaceAll,
    'pdf-rotate': (arg) => NpPdf.rotateCurrent(+arg),
    'pdf-delete-page': () => NpPdf.deleteCurrent(),
    'pdf-blank': () => NpPdf.insertBlank(),
    'pdf-add': () => NpPdf.addPages(),
    'pdf-ocr': (arg) => NpPdf.ocr(arg),
    'pdf-convert': () => NpPdf.convert(),
    'pdf-unconvert': () => NpPdf.unconvert(),
    'pdf-original': () => NpPdf.showOriginal(),
    'pdf-clear-hand': () => NpPdf.clearHandwriting(),
    'pdf-copy-text': () => NpPdf.copyText()
  };

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || t.disabled) return;
    const fn = ACTIONS[t.dataset.action];
    if (!fn) return;
    if (t.closest('.menu-pop')) closeMenus();
    e.preventDefault();
    fn(t.dataset.arg, t);
  });

  /* ----- keyboard shortcuts ----- */

  document.addEventListener('keydown', (e) => {
    if (pdfMode() && !openMenu && NpPdf.onKey(e)) return;
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;
      if (popover.open) { closePopover(); restoreSelection(); return; }
      if (openMenu) { closeMenus(); return; }
      if (findState.open) { closeFind(true); return; }
      if (selectedImage) { hideImageFrame(); return; }
      if (document.body.classList.contains('focus')) { toggleFocus(); return; }
    }
    if (e.key === 'F11' && document.body.classList.contains('focus')) return;
    if (!mod(e) || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    const inDoc = document.activeElement === editor;
    const code = e.code;
    const run = (fn) => { e.preventDefault(); fn(); };

    if (k === 's' && !e.shiftKey) return run(() => { saveNow('Saved by you').then(() => toast(!NpStore.persistent ? 'Saved for this visit only' : pdfMode() ? 'Saved' : 'Saved — a restore point was added to version history')); });
    if (k === 'o' && !e.shiftKey) return run(() => $('#file-open').click());
    if (k === 'p' && !e.shiftKey) return run(() => (pdfMode() ? printPdf() : printDoc()));
    if (k === 'f' && e.shiftKey) return run(toggleFocus);
    if (pdfMode()) {
      if (k === '/') run(shortcutsDialog);
      else if (e.altKey && code === 'KeyN') run(() => createDoc());
      return;
    }
    if (k === 'f' && !e.altKey) return run(() => openFind(false));
    if (k === 'h' && !e.shiftKey) return run(() => openFind(true));
    if (k === '/') return run(shortcutsDialog);
    if (e.altKey && code === 'KeyN') return run(() => createDoc());
    if (e.shiftKey && k === 'c' && !e.altKey) return run(wordCountDialog);
    if (!inDoc) return;
    if (k === 'k') return run(() => linkDialog(closestInEditor('a[href]')));
    if (k === '\\') return run(clearFormatting);
    if (k === 'e' && !e.shiftKey) return run(toggleInlineCode);
    if (k === '.' && !e.shiftKey) return run(() => exec('superscript'));
    if (k === ',' && !e.shiftKey) return run(() => exec('subscript'));
    if (e.shiftKey && code === 'KeyX') return run(() => exec('strikeThrough'));
    if (e.shiftKey && code === 'Digit7') return run(() => ACTIONS.cmd('insertOrderedList'));
    if (e.shiftKey && code === 'Digit8') return run(() => ACTIONS.cmd('insertUnorderedList'));
    if (e.shiftKey && code === 'Digit9') return run(toggleChecklist);
    if (e.shiftKey && code === 'KeyL') return run(() => exec('justifyLeft'));
    if (e.shiftKey && code === 'KeyE') return run(() => exec('justifyCenter'));
    if (e.shiftKey && code === 'KeyR') return run(() => exec('justifyRight'));
    if (e.shiftKey && code === 'KeyJ') return run(() => exec('justifyFull'));
    if (e.altKey && /^Digit[0-3]$/.test(code)) return run(() => setBlock(code === 'Digit0' ? 'p' : 'h' + code.slice(5)));
  });

  /* =========================================================== popovers */

  const popover = { el: $('#popover'), open: false, anchor: null };

  function openPopover(anchor, content, cls) {
    closeMenus();
    closePopover();
    const p = popover.el;
    p.className = 'popover ' + (cls || '');
    p.replaceChildren(content);
    p.hidden = false;
    popover.open = true;
    popover.anchor = anchor;
    if (anchor) anchor.setAttribute('data-popover-anchor', '');
    const target = anchor && anchor.closest('.menu') ? anchor.closest('.menu').querySelector('.menu-btn') : anchor;
    const r = (target && target.getBoundingClientRect().width ? target : $('#toolbar')).getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    p.style.left = clamp(r.left, 8, innerWidth - pr.width - 8) + 'px';
    p.style.top = clamp(r.bottom + 6, 8, innerHeight - pr.height - 8) + 'px';
  }

  function closePopover() {
    if (!popover.open) return;
    popover.el.hidden = true;
    popover.open = false;
    if (popover.anchor) popover.anchor.removeAttribute('data-popover-anchor');
    popover.anchor = null;
  }

  function colorPicker(kind, anchor) {
    const wrap = el('div', { class: 'color-pop' });
    const reset = el('button', { class: 'color-reset', type: 'button', onclick: () => { closePopover(); setColor(kind, null); } },
      kind === 'fore' ? 'Automatic' : 'No highlight');
    const grid = el('div', { class: 'swatches', role: 'listbox', 'aria-label': kind === 'fore' ? 'Text color' : 'Highlight color' });
    for (const c of PALETTE) {
      grid.append(el('button', { class: 'swatch', type: 'button', title: c, 'aria-label': c, style: 'background:' + c, onclick: () => { closePopover(); setColor(kind, c); } }));
    }
    const custom = el('input', { type: 'color', value: (kind === 'fore' ? settings.lastFore : settings.lastBack) || '#2563eb', 'aria-label': 'Custom color' });
    custom.addEventListener('change', () => { closePopover(); setColor(kind, custom.value); });
    wrap.append(reset, grid, el('label', { class: 'custom-color' }, custom, el('span', {}, 'Custom color…')));
    openPopover(anchor, wrap, 'pop-color');
  }

  function tablePicker(anchor) {
    const MAX = 10;
    const wrap = el('div', { class: 'grid-pop' });
    const label = el('div', { class: 'grid-label' }, 'Insert table');
    const grid = el('div', { class: 'grid-cells', style: 'grid-template-columns: repeat(' + MAX + ', 18px)' });
    const cells = [];
    const mark = (r, c) => {
      cells.forEach((x) => x.classList.toggle('on', +x.dataset.r <= r && +x.dataset.c <= c));
      label.textContent = r + ' × ' + c + ' table';
    };
    for (let r = 1; r <= MAX; r++) {
      for (let c = 1; c <= MAX; c++) {
        const cell = el('button', { class: 'grid-cell', type: 'button', 'data-r': r, 'data-c': c, 'aria-label': r + ' by ' + c,
          onmouseenter: () => mark(r, c), onfocus: () => mark(r, c), onclick: () => { closePopover(); insertTable(r, c); } });
        cells.push(cell);
        grid.append(cell);
      }
    }
    wrap.append(grid, label);
    openPopover(anchor, wrap, 'pop-grid');
  }

  function symbolPicker(anchor) {
    const wrap = el('div', { class: 'sym-pop' });
    for (const s of SYMBOLS) wrap.append(el('button', { class: 'sym', type: 'button', title: s, onclick: () => { closePopover(); exec('insertText', s); } }, s));
    openPopover(anchor, wrap, 'pop-sym');
  }

  /* =========================================================== dialogs */

  function dialog({ title, body, actions, wide, onOpen, initial }) {
    return new Promise((resolve) => {
      closeMenus();
      closePopover();
      const d = el('dialog', { class: 'dialog' + (wide ? ' wide' : '') });
      const form = el('form', { method: 'dialog' });
      const head = el('header', { class: 'dlg-head' }, el('h2', {}, title),
        el('button', { class: 'icon-btn sm', type: 'button', 'data-icon': 'close', 'aria-label': 'Close', onclick: () => d.close('') }));
      const main = el('div', { class: 'dlg-body' });
      if (typeof body === 'string') main.innerHTML = body; else if (body) main.append(body);
      const foot = el('footer', { class: 'dlg-foot' });
      for (const a of actions || [{ label: 'Close', value: '' }]) {
        foot.append(el('button', { class: 'btn' + (a.primary ? ' btn-primary' : '') + (a.danger ? ' btn-danger' : ''), value: a.value, type: a.primary ? 'submit' : 'button',
          onclick: a.primary ? null : () => d.close(a.value) }, a.label));
      }
      form.append(head, main, foot);
      d.append(form);
      document.body.append(d);
      NpIcons.inject(d);
      d.addEventListener('close', () => {
        const v = d.returnValue;
        d.remove();
        resolve(v || null);
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const primary = (actions || []).find((a) => a.primary);
        d.close(primary ? primary.value : 'ok');
      });
      d.showModal();
      if (onOpen) onOpen(d, main);
      const focusEl = initial ? main.querySelector(initial) : null;
      if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }
    });
  }

  async function confirmDialog(title, text, { ok = 'OK', danger = false } = {}) {
    const v = await dialog({ title, body: el('p', { class: 'dlg-text' }, text), actions: [{ label: 'Cancel', value: '' }, { label: ok, value: 'ok', primary: true, danger }] });
    return v === 'ok';
  }

  async function promptDialog(title, label, value, opts = {}) {
    const input = el('input', { type: opts.type || 'text', class: 'input', value: value || '', placeholder: opts.placeholder || '', min: opts.min, max: opts.max });
    const body = el('label', { class: 'field' }, el('span', {}, label), input);
    const v = await dialog({ title, body, actions: [{ label: 'Cancel', value: '' }, { label: opts.ok || 'OK', value: 'ok', primary: true }], initial: 'input' });
    return v === 'ok' ? input.value : null;
  }

  function radioGroup(name, options, value) {
    return el('div', { class: 'radios', role: 'radiogroup' }, options.map(([v, label]) =>
      el('label', { class: 'radio' }, el('input', { type: 'radio', name, value: String(v), checked: String(v) === String(value) }), el('span', {}, label))));
  }

  async function linkDialog(existing) {
    restoreSelection();
    const range = currentRange();
    const selected = existing ? existing.textContent : (getSelection().toString() || '');
    const textIn = el('input', { class: 'input', type: 'text', value: selected, placeholder: 'Text to show' });
    const urlIn = el('input', { class: 'input url-in', type: 'text', value: existing ? existing.getAttribute('href') : '', placeholder: 'https://example.com or name@example.com' });
    const body = el('div', { class: 'stack' },
      el('label', { class: 'field' }, el('span', {}, 'Text'), textIn),
      el('label', { class: 'field' }, el('span', {}, 'Link'), urlIn));
    const actions = [{ label: 'Cancel', value: '' }];
    if (existing) actions.push({ label: 'Remove link', value: 'remove' });
    actions.push({ label: existing ? 'Update' : 'Insert', value: 'ok', primary: true });
    const v = await dialog({ title: existing ? 'Edit link' : 'Insert link', body, actions, initial: '.url-in' });
    editor.focus({ preventScroll: true });
    if (range) { getSelection().removeAllRanges(); getSelection().addRange(range); }
    if (v === 'remove' && existing) { selectNode(existing, true); exec('unlink'); return; }
    if (v !== 'ok') return;
    let url = urlIn.value.trim();
    if (!url) return;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) url = 'mailto:' + url;
    else if (!/^[a-z][a-z0-9+.-]*:|^#|^\//i.test(url)) url = 'https://' + url;
    if (!NpSanitize.safeHref(url)) { toast('That link type is not allowed.'); return; }
    const text = textIn.value || url;
    if (existing) {
      const inner = text === existing.textContent ? existing.innerHTML : escapeHtml(text);
      replaceUndoable(existing, '<a href="' + escapeHtml(url) + '">' + inner + '</a>');
    } else if (selected && text === selected) {
      exec('createLink', url);
    } else {
      exec('insertHTML', '<a href="' + escapeHtml(url) + '">' + escapeHtml(text) + '</a>&nbsp;');
    }
  }

  async function pageSetupDialog() {
    if (!current) return;
    const s = docSettings();
    const font = el('select', { class: 'input' }, FONTS.map((f) => el('option', { value: f.key, selected: f.key === s.font }, f.label)));
    const size = el('select', { class: 'input' }, SIZES.map((n) => el('option', { value: n, selected: n === s.size }, n + ' pt')));
    const body = el('div', { class: 'stack' },
      el('div', { class: 'row2' },
        el('label', { class: 'field' }, el('span', {}, 'Font'), font),
        el('label', { class: 'field' }, el('span', {}, 'Size'), size)),
      el('div', { class: 'field' }, el('span', {}, 'Line spacing'), radioGroup('lh', LINE_HEIGHTS.map((n) => [n, n === 1 ? 'Single' : n === 2 ? 'Double' : String(n)]), s.lineHeight)),
      el('div', { class: 'field' }, el('span', {}, 'Paper size'), radioGroup('paper', Object.entries(PAPER).map(([k, v]) => [k, v.label]), s.paper)),
      el('div', { class: 'field' }, el('span', {}, 'Margins'), radioGroup('margins', Object.entries(MARGINS).map(([k, v]) => [k, v.label]), s.margins)),
      el('label', { class: 'toggle-row' }, el('span', {}, 'Use these settings for new documents'), el('input', { type: 'checkbox', class: 'switch', id: 'ps-default' })));
    const v = await dialog({ title: 'Page setup', body, actions: [{ label: 'Cancel', value: '' }, { label: 'Apply', value: 'ok', primary: true }] });
    if (v !== 'ok') return;
    const next = {
      font: font.value, size: +size.value,
      lineHeight: +body.querySelector('input[name=lh]:checked').value,
      paper: body.querySelector('input[name=paper]:checked').value,
      margins: body.querySelector('input[name=margins]:checked').value
    };
    current.settings = next;
    if (body.querySelector('#ps-default').checked) { settings.defaults = Object.assign({}, next); saveSettings(); }
    applyDocSettings();
    markDirty();
  }

  async function goalDialog() {
    if (!current) return;
    const v = await promptDialog('Word goal', 'Words to aim for in this document (0 turns it off)', String(current.goal || ''), { type: 'number', min: 0, placeholder: 'e.g. 1000', ok: 'Set goal' });
    if (v == null) return;
    current.goal = Math.max(0, parseInt(v, 10) || 0);
    markDirty();
    refreshMetrics();
  }

  function stats(text) {
    const words = (text.match(WORD_RE) || []).length;
    return {
      words,
      chars: text.replace(/\n/g, '').length,
      charsNoSpace: text.replace(/\s/g, '').length,
      paragraphs: text.split(/\n+/).filter((s) => s.trim()).length,
      sentences: (text.match(/[^.!?…\n]+[.!?…]+/g) || []).length || (words ? 1 : 0),
      read: words / 238,
      speak: words / 150
    };
  }

  function minutes(m) {
    if (m < 1) return m * 60 < 1 ? '0 sec' : Math.max(1, Math.round(m * 60)) + ' sec';
    if (m < 60) return Math.round(m) + ' min';
    return Math.floor(m / 60) + ' hr ' + Math.round(m % 60) + ' min';
  }

  function wordCountDialog() {
    const all = stats(plainText());
    const s = getSelection();
    const sel = selectionInEditor() && !s.isCollapsed ? stats(s.toString()) : null;
    const rows = [['Words', 'words'], ['Characters', 'chars'], ['Characters without spaces', 'charsNoSpace'], ['Paragraphs', 'paragraphs'], ['Sentences', 'sentences']];
    const table = el('table', { class: 'stats' },
      el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Document'), sel ? el('th', {}, 'Selection') : null)),
      el('tbody', {}, rows.map(([label, k]) => el('tr', {}, el('td', {}, label), el('td', {}, fmtNum(all[k])), sel ? el('td', {}, fmtNum(sel[k])) : null)),
        el('tr', {}, el('td', {}, 'Reading time'), el('td', {}, minutes(all.read)), sel ? el('td', {}, minutes(sel.read)) : null),
        el('tr', {}, el('td', {}, 'Speaking time'), el('td', {}, minutes(all.speak)), sel ? el('td', {}, minutes(sel.speak)) : null)));
    dialog({ title: 'Word count', body: table });
  }

  async function historyDialog() {
    if (!current) return;
    await saveNow();
    const list = await NpStore.listVersions(current.id);
    const preview = el('div', { class: 'hist-preview editor' }, el('p', { class: 'muted' }, list.length ? 'Pick a version to preview it.' : 'No earlier versions yet. A restore point is saved every 10 minutes while you write, and whenever you press Ctrl+S.'));
    let chosen = null;
    const items = el('ul', { class: 'hist-list' }, list.map((v) => el('li', {},
      el('button', { type: 'button', class: 'hist-item', onclick: async (e) => {
        $$('.hist-item', items).forEach((b) => b.classList.remove('on'));
        e.currentTarget.classList.add('on');
        const full = await NpStore.getVersion(v.vid);
        chosen = full;
        preview.innerHTML = NpSanitize.html(full.html) || '<p class="muted">(empty)</p>';
        restoreBtn.disabled = false;
      } }, el('strong', {}, fmtDate(v.time)), el('span', {}, v.reason + ' · ' + ago(v.time))))));
    const restoreBtn = el('button', { class: 'btn btn-primary', type: 'button', disabled: true, onclick: () => d && d.close('restore') });
    restoreBtn.textContent = 'Restore this version';
    let d = null;
    const body = el('div', { class: 'hist' }, items, preview);
    const p = dialog({ title: 'Version history', body, wide: true, actions: [{ label: 'Close', value: '' }], onOpen: (dlg) => { d = dlg; dlg.querySelector('.dlg-foot').prepend(restoreBtn); } });
    const v = await p;
    if (v === 'restore' && chosen) {
      await NpStore.addVersion(current.id, serialize(), displayTitle(current), 'Before restoring');
      editor.focus();
      selectNode(editor, true);
      document.execCommand('insertHTML', false, NpSanitize.html(chosen.html) || '<p><br></p>');
      afterEdit();
      await saveNow();
      toast('Version restored. Undo (Ctrl+Z) brings back what you had.');
    }
  }

  function shortcutsDialog() {
    const k = (s) => s.split(' / ').map((x) => '<kbd>' + escapeHtml(isMac ? x.replace(/Ctrl/g, '⌘').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧') : x) + '</kbd>').join(' ');
    const groups = [
      ['Text', [['Bold', 'Ctrl+B'], ['Italic', 'Ctrl+I'], ['Underline', 'Ctrl+U'], ['Strikethrough', 'Ctrl+Shift+X'], ['Inline code', 'Ctrl+E'], ['Superscript / subscript', 'Ctrl+. / Ctrl+,'], ['Link', 'Ctrl+K'], ['Clear formatting', 'Ctrl+\\']]],
      ['Paragraphs', [['Normal text', 'Ctrl+Alt+0'], ['Heading 1–3', 'Ctrl+Alt+1 / Ctrl+Alt+3'], ['Numbered list', 'Ctrl+Shift+7'], ['Bulleted list', 'Ctrl+Shift+8'], ['Checklist', 'Ctrl+Shift+9'], ['Align left / center / right / justify', 'Ctrl+Shift+L / Ctrl+Shift+E / Ctrl+Shift+R / Ctrl+Shift+J'], ['Indent list item', 'Tab / Shift+Tab'], ['Page break', 'Ctrl+Enter']]],
      ['Document', [['Save a restore point', 'Ctrl+S'], ['Open a file', 'Ctrl+O'], ['New document', 'Ctrl+Alt+N'], ['Find / replace', 'Ctrl+F / Ctrl+H'], ['Print', 'Ctrl+P'], ['Word count', 'Ctrl+Shift+C'], ['Focus mode', 'Ctrl+Shift+F'], ['Paste without formatting', 'Ctrl+Shift+V']]],
      ['PDF tools (single keys, while a PDF is open)', [['Select and move', 'V'], ['Edit the PDF’s text', 'E'], ['Add text', 'T'], ['Highlight', 'H'], ['White-out', 'W'], ['Draw', 'D'], ['Box', 'B'], ['Delete what is selected', 'Delete'], ['Nudge what is selected', 'Arrow keys']]],
      ['Markdown shortcuts (type, then space)', [['Heading 1, 2, 3', '# / ## / ###'], ['Bulleted list', '- / *'], ['Numbered list', '1.'], ['Checklist', '[ ]'], ['Quote', '>'], ['Code block', '```'], ['Horizontal line (then Enter)', '---']]]
    ];
    const html = groups.map(([g, rows]) => '<h3>' + escapeHtml(g) + '</h3><table class="keys">' +
      rows.map(([a, b]) => '<tr><td>' + escapeHtml(a) + '</td><td>' + (g.startsWith('Markdown') ? b.split(' / ').map((x) => '<code>' + escapeHtml(x) + '</code>').join(' ') : k(b)) + '</td></tr>').join('') + '</table>').join('');
    dialog({ title: 'Keyboard shortcuts', body: el('div', { class: 'keys-wrap', html }), wide: true });
  }

  async function aboutDialog() {
    let usage = '';
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        usage = (e.usage / 1048576).toFixed(1) + ' MB used';
      }
    } catch (e) { /* not available */ }
    let persisted = false;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { /* not available */ }
    const body = el('div', { class: 'stack about' },
      el('p', {}, 'Notepad Online is a word processor that runs entirely in your browser. Nothing you write is sent anywhere — documents are stored on this device, in this browser.'),
      el('ul', { class: 'facts' },
        el('li', {}, el('strong', {}, String(docs.length)), ' document' + (docs.length === 1 ? '' : 's') + (usage ? ' · ' + usage : '')),
        el('li', {}, NpStore.persistent ? (persisted ? 'Storage is marked persistent: the browser will not clear it to free space.' : 'Storage is “best effort”: a browser short on disk space may clear it. Back up anything important.') : 'This browser is not allowing storage (private window?). Work is kept only until you close the tab.'),
        el('li', {}, 'Works offline once loaded, and can be installed as an app from your browser’s menu.'),
        el('li', {}, 'Version ' + APP_VERSION)),
      el('p', { class: 'muted' }, 'Tip: File → Back up all documents saves everything to one file you can restore on another computer.'));
    dialog({ title: 'About and storage', body });
  }

  async function editAlt(img) {
    const v = await promptDialog('Alt text', 'Describe the image for screen readers and when it cannot load', img.getAttribute('alt') || '');
    if (v == null) return;
    setImage(img, (c) => c.setAttribute('alt', v));
  }

  async function imageUrlDialog() {
    restoreSelection();
    const range = currentRange();
    const v = await promptDialog('Image from a link', 'Image address (https://…)', '', { placeholder: 'https://example.com/picture.jpg', ok: 'Insert' });
    if (!v) return;
    if (!/^https?:\/\//i.test(v.trim())) { toast('Use an address starting with https://'); return; }
    editor.focus();
    if (range) { getSelection().removeAllRanges(); getSelection().addRange(range); }
    exec('insertHTML', '<img src="' + escapeHtml(v.trim()) + '" alt="">');
  }

  function voiceDialog() {
    if (!('speechSynthesis' in window)) { toast('This browser cannot read text aloud.'); return; }
    const voices = speechSynthesis.getVoices();
    const select = el('select', { class: 'input' }, el('option', { value: '' }, 'Default voice'),
      voices.map((v) => el('option', { value: v.name, selected: v.name === settings.voice }, v.name + ' (' + v.lang + ')')));
    const rate = el('input', { type: 'range', min: '0.5', max: '2', step: '0.1', value: String(settings.rate) });
    const rateLabel = el('span', { class: 'muted' }, settings.rate.toFixed(1) + '×');
    rate.addEventListener('input', () => { rateLabel.textContent = (+rate.value).toFixed(1) + '×'; });
    const body = el('div', { class: 'stack' },
      el('label', { class: 'field' }, el('span', {}, 'Voice'), select),
      el('label', { class: 'field' }, el('span', {}, 'Speed ', rateLabel), rate));
    dialog({ title: 'Voice settings', body, actions: [{ label: 'Cancel', value: '' }, { label: 'Save', value: 'ok', primary: true }] }).then((v) => {
      if (v !== 'ok') return;
      settings.voice = select.value;
      settings.rate = +rate.value;
      saveSettings();
    });
  }

  /* =========================================================== find & replace */

  const findState = { open: false, ranges: [], texts: [], cur: -1 };
  const findQ = $('#find-q');
  const findR = $('#find-r');
  const hasHighlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

  function openFind(replace) {
    const s = getSelection();
    const selText = selectionInEditor() && !s.isCollapsed ? s.toString() : '';
    $('#find').hidden = false;
    $('#find').classList.toggle('with-replace', !!replace || !!findR.value);
    findState.open = true;
    if (selText && !selText.includes('\n') && selText.length < 200) findQ.value = selText;
    const target = replace && findQ.value ? findR : findQ;
    target.focus();
    target.select();
    runFind(true);
  }

  function closeFind(focusDoc) {
    if (!findState.open) return;
    $('#find').hidden = true;
    findState.open = false;
    const r = findState.ranges[findState.cur];
    clearFindHighlights();
    if (focusDoc) {
      editor.focus({ preventScroll: true });
      if (r) { getSelection().removeAllRanges(); getSelection().addRange(r); }
    }
    findState.ranges = [];
  }

  function clearFindHighlights() {
    if (!hasHighlights) return;
    CSS.highlights.delete('np-find');
    CSS.highlights.delete('np-find-cur');
  }

  function findRegex(global) {
    const q = findQ.value;
    if (!q) return null;
    let src = $('#find-regex').checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if ($('#find-word').checked) src = '(?<![\\p{L}\\p{N}_])(?:' + src + ')(?![\\p{L}\\p{N}_])';
    try {
      return new RegExp(src, (global ? 'g' : '') + ($('#find-case').checked ? '' : 'i') + 'u');
    } catch (e) {
      return false;
    }
  }

  function runFind(resetCursor) {
    if (!findState.open) return;
    const re = findRegex(true);
    findState.ranges = [];
    findState.texts = [];
    const count = $('#find-count');
    if (!re) {
      clearFindHighlights();
      count.textContent = re === false ? 'Bad pattern' : '';
      count.classList.toggle('bad', re === false);
      return;
    }
    count.classList.remove('bad');
    const idx = textIndex();
    let m;
    while ((m = re.exec(idx.text)) && findState.ranges.length < 5000) {
      if (!m[0]) { re.lastIndex++; continue; }
      const r = idx.range(m.index, m.index + m[0].length);
      if (r) { findState.ranges.push(r); findState.texts.push(m[0]); }
    }
    const n = findState.ranges.length;
    if (resetCursor || findState.cur >= n) {
      // start at the first match after the caret
      findState.cur = -1;
      if (n && savedRange) {
        const at = findState.ranges.findIndex((r) => r.compareBoundaryPoints(Range.START_TO_START, savedRange) >= 0);
        findState.cur = at;
      }
      if (findState.cur < 0 && n) findState.cur = 0;
    }
    paintFind();
  }

  const scheduleFind = debounce(() => runFind(false), 200);
  findQ.addEventListener('input', debounce(() => runFind(true), 120));
  ['find-case', 'find-word', 'find-regex'].forEach((id) => $('#' + id).addEventListener('change', () => runFind(true)));

  function paintFind() {
    const n = findState.ranges.length;
    $('#find-count').textContent = findQ.value ? (n ? (findState.cur + 1) + ' of ' + n + (n >= 5000 ? '+' : '') : 'No results') : '';
    if (!hasHighlights) return;
    CSS.highlights.set('np-find', new Highlight(...findState.ranges));
    const cur = findState.ranges[findState.cur];
    if (cur) {
      CSS.highlights.set('np-find-cur', new Highlight(cur));
      scrollRangeIntoView(cur);
    } else CSS.highlights.delete('np-find-cur');
  }

  function scrollRangeIntoView(r) {
    const rect = r.getBoundingClientRect();
    const ws = workspace.getBoundingClientRect();
    if (!rect.height && !rect.width) return;
    if (rect.top < ws.top + 60 || rect.bottom > ws.bottom - 40) workspace.scrollTop += rect.top - ws.top - ws.height / 3;
  }

  function findStep(dir) {
    if (!findState.open) { openFind(false); return; }
    const n = findState.ranges.length;
    if (!n) return;
    findState.cur = (findState.cur + dir + n) % n;
    paintFind();
    if (!hasHighlights) {
      const r = findState.ranges[findState.cur];
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
  }

  findQ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  });
  findR.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (mod(e) && e.altKey) replaceAll(); else replaceOne(); }
  });
  findR.addEventListener('focus', () => $('#find').classList.add('with-replace'));

  function replacementFor(text) {
    const rep = findR.value;
    if (!$('#find-regex').checked) return rep;
    const re = findRegex(false);
    return re ? text.replace(re, rep) : rep;
  }

  function replaceOne() {
    const r = findState.ranges[findState.cur];
    if (!r) { runFind(true); return; }
    const text = replacementFor(findState.texts[findState.cur]);
    editor.focus({ preventScroll: true });
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    if (text) document.execCommand('insertText', false, text); else document.execCommand('delete');
    afterEdit();
    runFind(false);
    paintFind();
    findR.focus();
  }

  async function replaceAll() {
    runFind(false);
    const n = findState.ranges.length;
    if (!n) return;
    await saveNow('Before replace all');
    editor.focus({ preventScroll: true });
    for (let i = n - 1; i >= 0; i--) {
      const text = replacementFor(findState.texts[i]);
      getSelection().removeAllRanges();
      getSelection().addRange(findState.ranges[i]);
      if (text) document.execCommand('insertText', false, text); else document.execCommand('delete');
    }
    afterEdit();
    runFind(true);
    findR.focus();
    toast('Replaced ' + fmtNum(n) + ' match' + (n === 1 ? '' : 'es'));
  }

  /* =========================================================== images */

  let selectedImage = null;
  const frame = $('#img-frame');

  function selectImage(img) {
    selectedImage = img;
    selectNode(img);
    positionImageFrame();
    frame.hidden = false;
    updateCtxBar();
  }

  function hideImageFrame() {
    if (!selectedImage) return;
    selectedImage = null;
    frame.hidden = true;
    updateCtxBar();
  }

  function positionImageFrame() {
    if (!selectedImage) return;
    if (!editor.contains(selectedImage)) { hideImageFrame(); return; }
    const r = selectedImage.getBoundingClientRect();
    const ws = workspace.getBoundingClientRect();
    frame.style.left = (r.left - ws.left + workspace.scrollLeft) + 'px';
    frame.style.top = (r.top - ws.top + workspace.scrollTop) + 'px';
    frame.style.width = r.width + 'px';
    frame.style.height = r.height + 'px';
  }
  window.addEventListener('resize', () => { positionImageFrame(); });

  $('#img-handle').addEventListener('pointerdown', (e) => {
    if (!selectedImage) return;
    e.preventDefault();
    const img = selectedImage;
    const start = img.getBoundingClientRect();
    const ratio = start.height / start.width;
    const x0 = e.clientX;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let w = start.width;
    const move = (ev) => {
      w = Math.max(24, start.width + (ev.clientX - x0));
      frame.style.width = w + 'px';
      frame.style.height = w * ratio + 'px';
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      const er = editor.getBoundingClientRect();
      const scale = er.width / editor.offsetWidth || 1;
      const cs = getComputedStyle(editor);
      const contentW = (editor.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * scale;
      const pct = clamp(Math.round((w / contentW) * 100), 5, 100);
      setImage(img, (c) => { c.style.width = pct + '%'; });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  function setImage(img, change) {
    const clone = img.cloneNode(false);
    change(clone);
    const tok = uid();
    clone.setAttribute('data-np-t', tok);
    const next = replaceUndoable(img, clone.outerHTML, 'img[data-np-t="' + tok + '"]');
    if (next) {
      if (next.complete) selectImage(next); else next.addEventListener('load', () => selectImage(next), { once: true });
    } else hideImageFrame();
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
  }

  // Large photos are scaled down so a document stays light enough to save.
  async function prepareImage(file) {
    if (file.type === 'image/gif' || (file.size < 300 * 1024 && /^image\/(png|jpeg)$/.test(file.type))) return readAsDataURL(file);
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('That image could not be read.'));
        i.src = url;
      });
      const max = 1800;
      const w0 = img.naturalWidth || 800;
      const h0 = img.naturalHeight || 600;
      const scale = Math.min(1, max / Math.max(w0, h0));
      const c = document.createElement('canvas');
      c.width = Math.round(w0 * scale);
      c.height = Math.round(h0 * scale);
      const ctx = c.getContext('2d');
      const png = file.type === 'image/png' || file.type === 'image/svg+xml';
      if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function insertImageFile(file) {
    try {
      const src = await prepareImage(file);
      const alt = file.name ? file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') : '';
      exec('insertHTML', '<img src="' + src + '" alt="' + escapeHtml(alt) + '">');
    } catch (e) {
      toast(e.message || 'That image could not be added.');
    }
  }

  $('#file-image').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) insertImageFile(f);
  });

  workspace.addEventListener('scroll', () => { if (selectedImage) positionImageFrame(); }, { passive: true });

  /* =========================================================== tables */

  function insertTable(rows, cols) {
    let html = '<table><tbody>';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) html += r === 0 && rows > 1 ? '<th><br></th>' : '<td><br></td>';
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    exec('insertHTML', html);
    const tables = $$('table', editor);
    const s = getSelection();
    const near = tables.find((t) => s.rangeCount && t.compareDocumentPosition(s.getRangeAt(0).startContainer) & Node.DOCUMENT_POSITION_FOLLOWING && t.nextElementSibling && t.nextElementSibling.contains(s.getRangeAt(0).startContainer));
    const t = near || tables[tables.length - 1];
    if (t && t.rows[0]) caretTo(t.rows[0].cells[0]);
  }

  function emptyCell(tag) { return '<' + tag + '><br></' + tag + '>'; }

  function tableOp(op) {
    const cell = closestInEditor('td,th');
    if (!cell) return;
    const table = cell.closest('table');
    if (op === 'del-table') { selectNode(table); exec('delete'); return; }
    const rIdx = cell.parentElement.rowIndex;
    const cIdx = cell.cellIndex;
    const clone = table.cloneNode(true);
    const rows = Array.from(clone.rows);
    const row = rows[rIdx];
    let target = [rIdx, cIdx];
    if (op === 'row-above' || op === 'row-below') {
      const n = Array.from(row.cells).reduce((s, c) => s + (c.colSpan || 1), 0);
      const nr = document.createElement('tr');
      nr.innerHTML = Array(n).fill(emptyCell('td')).join('');
      if (op === 'row-above' && rIdx === 0 && row.cells[0].tagName === 'TH') {
        // a row above the header row becomes the new header
        nr.innerHTML = Array(n).fill(emptyCell('th')).join('');
        row.innerHTML = Array.from(row.cells).map((c) => '<td' + (c.colSpan > 1 ? ' colspan="' + c.colSpan + '"' : '') + '>' + c.innerHTML + '</td>').join('');
      }
      row.parentNode.insertBefore(nr, op === 'row-above' ? row : row.nextSibling);
      target = [op === 'row-above' ? rIdx : rIdx + 1, Math.min(cIdx, n - 1)];
    } else if (op === 'col-left' || op === 'col-right') {
      for (const r of rows) {
        const ref = r.cells[Math.min(cIdx, r.cells.length - 1)];
        const tag = ref ? ref.tagName.toLowerCase() : 'td';
        const tmp = document.createElement('tr');
        tmp.innerHTML = emptyCell(tag);
        const nc = tmp.firstChild;
        if (!ref) r.appendChild(nc);
        else r.insertBefore(nc, op === 'col-left' ? ref : ref.nextSibling);
      }
      target = [rIdx, op === 'col-left' ? cIdx : cIdx + 1];
    } else if (op === 'del-row') {
      if (rows.length <= 1) { selectNode(table); exec('delete'); return; }
      row.remove();
      target = [Math.min(rIdx, rows.length - 2), cIdx];
    } else if (op === 'del-col') {
      if (rows.every((r) => r.cells.length <= 1)) { selectNode(table); exec('delete'); return; }
      for (const r of rows) if (r.cells[cIdx]) r.cells[cIdx].remove();
      target = [rIdx, Math.max(0, cIdx - 1)];
    } else if (op === 'header') {
      const first = rows[0];
      const toTag = first.cells[0] && first.cells[0].tagName === 'TH' ? 'td' : 'th';
      first.innerHTML = Array.from(first.cells).map((c) => '<' + toTag + (c.colSpan > 1 ? ' colspan="' + c.colSpan + '"' : '') + '>' + c.innerHTML + '</' + toTag + '>').join('');
    }
    const tok = uid();
    clone.setAttribute('data-np-t', tok);
    const next = replaceUndoable(table, clone.outerHTML, 'table[data-np-t="' + tok + '"]');
    if (next) {
      const r = next.rows[clamp(target[0], 0, next.rows.length - 1)];
      const c = r && r.cells[clamp(target[1], 0, r.cells.length - 1)];
      if (c) caretTo(c, true);
    }
    updateCtxBar();
  }

  function moveCell(cell, dir) {
    const table = cell.closest('table');
    const cells = $$('th,td', table).filter((c) => c.closest('table') === table);
    const i = cells.indexOf(cell);
    const next = cells[i + dir];
    if (next) { selectNode(next, true); return; }
    if (dir > 0) {
      caretTo(cells[cells.length - 1], true);
      tableOp('row-below');
      const row = closestInEditor('tr');
      if (row && row.cells[0]) caretTo(row.cells[0]);
    }
  }

  /* =========================================================== files */

  function safeFileName(name, ext) {
    const base = String(name || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'document';
    return base + '.' + ext;
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  function exportCss() {
    const s = docSettings();
    return [
      'body{margin:0;background:#f3f4f6;color:#1f2328;font-family:' + fontByKey(s.font).css + ';font-size:' + s.size + 'pt;line-height:' + s.lineHeight + '}',
      'article{box-sizing:border-box;max-width:' + PAPER[s.paper].w + ';margin:24px auto;padding:' + MARGINS[s.margins].css + ';background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1);white-space:pre-wrap;overflow-wrap:break-word}',
      '@media (max-width:700px){article{margin:0;padding:20px}}',
      '@media print{body{background:#fff}article{box-shadow:none;margin:0;padding:0;max-width:none}}',
      '@page{size:' + PAPER[s.paper].css + ';margin:' + MARGINS[s.margins].css + '}',
      'p{margin:0}h1,h2,h3,h4{line-height:1.25;margin:.9em 0 .35em}h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}',
      'blockquote{margin:.6em 0;padding:.1em 0 .1em 1em;border-left:3px solid #c9ced6;color:#4b5563}',
      'pre{background:#f3f4f6;padding:.8em 1em;border-radius:6px;font-family:"Courier New",monospace;font-size:.9em;white-space:pre-wrap}',
      'code{background:#f3f4f6;padding:.1em .3em;border-radius:4px;font-family:"Courier New",monospace;font-size:.92em}',
      'table{border-collapse:collapse;width:100%;margin:.6em 0}th,td{border:1px solid #c9ced6;padding:.35em .6em;vertical-align:top;text-align:left}th{background:#f2f3f5}',
      'img{max-width:100%;height:auto}img.img-center{display:block;margin:.5em auto}img.img-left{float:left;margin:.2em 1em .5em 0}img.img-right{float:right;margin:.2em 0 .5em 1em}',
      'ul.checklist{list-style:none;padding-left:.2em}ul.checklist>li::before{content:"☐ "}ul.checklist>li[data-checked="true"]::before{content:"☑ "}ul.checklist>li[data-checked="true"]{text-decoration:line-through;color:#6b7280}',
      'hr{border:0;border-top:1px solid #c9ced6;margin:1em 0}hr.page-break{border:0;break-after:page;margin:0}',
      'a{color:#1155cc}'
    ].join('\n');
  }

  async function exportAs(kind) {
    if (!current) return;
    await saveNow();
    const name = displayTitle(current);
    try {
      if (kind === 'txt') {
        download(new Blob([textIndex(true).text.replace(/\n{3,}/g, '\n\n').trim() + '\n'], { type: 'text/plain;charset=utf-8' }), safeFileName(name, 'txt'));
      } else if (kind === 'md') {
        download(new Blob([NpMarkdown.fromDom(editor)], { type: 'text/markdown;charset=utf-8' }), safeFileName(name, 'md'));
      } else if (kind === 'html') {
        const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + escapeHtml(name) +
          '</title>\n<style>\n' + exportCss() + '\n</style>\n</head>\n<body>\n<article>' + serialize() + '</article>\n</body>\n</html>\n';
        download(new Blob([html], { type: 'text/html;charset=utf-8' }), safeFileName(name, 'html'));
      } else if (kind === 'docx') {
        setStatus('Preparing Word file…', 'pending');
        const s = docSettings();
        const blob = await NpDocx.export(editor, { title: name, fontCss: fontByKey(s.font).css, size: s.size, lineHeight: s.lineHeight, page: s.paper, margins: s.margins });
        download(blob, safeFileName(name, 'docx'));
        setStatus('Saved', 'ok');
      } else if (kind === 'pdf') {
        toast('In the print window, choose “Save as PDF” as the printer.', 5000);
        setTimeout(printDoc, 400);
      }
    } catch (e) {
      setStatus('Saved', 'ok');
      toast('Export failed: ' + (e.message || e), 6000);
    }
  }

  function printDoc() {
    hideImageFrame();
    closeFind(false);
    const prev = document.title;
    if (current) document.title = displayTitle(current);
    window.print();
    document.title = prev;
  }

  async function openFiles(files) {
    let last = null;
    for (const file of files) {
      try {
        const name = file.name.replace(/\.[^.]+$/, '');
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        let html;
        if (ext === 'pdf' || file.type === 'application/pdf') { last = (await createPdfDoc(file, name)) || last; continue; }
        if (ext === 'docx') html = NpSanitize.html(await NpDocx.import(await file.arrayBuffer()));
        else if (ext === 'doc') { toast('Old .doc files cannot be opened. In Word, use Save As → .docx first.', 6000); continue; }
        else if (ext === 'md' || ext === 'markdown' || file.type === 'text/markdown') html = NpSanitize.html(NpMarkdown.toHtml(await file.text()));
        else if (ext === 'html' || ext === 'htm' || file.type === 'text/html') html = NpSanitize.html(await file.text(), { external: true });
        else if (ext === 'json') { await restoreBackupFile(file); continue; }
        else if (file.type.startsWith('text/') || ['txt', 'text', 'csv', 'log', ''].includes(ext)) {
          const text = (await file.text()).replace(/\r\n?/g, '\n');
          html = text.split('\n').map((l) => '<p>' + (escapeHtml(l) || '<br>') + '</p>').join('');
        } else { toast('“' + file.name + '” is not a file type Notepad can open.'); continue; }
        last = await createDoc(html || '<p><br></p>', name, { keepFocus: true });
      } catch (e) {
        toast('Could not open “' + file.name + '”: ' + (e.message || e), 6000);
      }
    }
    if (last) { if (last.type !== 'pdf') placeCaretAtStart(); toast(files.length > 1 ? 'Files opened as new documents' : 'Opened as a new document'); }
  }

  $('#file-open').addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (files.length) openFiles(files);
  });

  async function duplicateDoc() {
    if (!current) return;
    await saveNow();
    const src = current;
    if (src.type === 'pdf') {
      const now = Date.now();
      const copy = Object.assign(JSON.parse(JSON.stringify(Object.assign({}, src, { sources: null }))), {
        id: uid(), title: 'Copy of ' + displayTitle(src), titleAuto: false, created: now, updated: now, sources: src.sources.map((b) => b.slice(0))
      });
      await addRecord(copy);
      toast('Copy created');
      return;
    }
    await createDoc(src.html, 'Copy of ' + displayTitle(src), { settings: src.settings, keepFocus: true });
    toast('Copy created');
  }

  async function backupAll() {
    await saveNow();
    const all = (await NpStore.allDocs()).map((d) => (d.type === 'pdf' ? Object.assign({}, d, { sources: d.sources.map(bufToB64) }) : d));
    const data = { app: 'notepad-online', format: 1, exported: new Date().toISOString(), docs: all };
    const stamp = new Date().toISOString().slice(0, 10);
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'notepad-backup-' + stamp + '.json');
    toast('Backup downloaded (' + all.length + ' document' + (all.length === 1 ? '' : 's') + ')');
  }

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function b64ToBuf(b64) {
    const bin = atob(String(b64));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // A PDF from a backup: keep only the fields the editor knows, with sane types.
  function restoredPdf(raw, id) {
    const num = (v) => (Number.isFinite(+v) ? +v : 0);
    const items = (Array.isArray(raw.items) ? raw.items : []).filter((it) => it && typeof it === 'object' && typeof it.page === 'string' &&
      ['text', 'image', 'highlight', 'whiteout', 'box', 'ink', 'hand'].includes(it.type) && (it.type !== 'image' || /^data:image\/(png|jpeg);base64,/.test(it.src)));
    return Object.assign(newDocRecord('', String(raw.title || 'PDF')), {
      id, type: 'pdf', titleAuto: false, text: String(raw.text || ''),
      created: num(raw.created) || Date.now(), updated: num(raw.updated) || Date.now(),
      sources: raw.sources.map(b64ToBuf),
      pages: raw.pages.filter((p) => p && typeof p.uid === 'string').map((p) => ({ uid: p.uid, src: num(p.src), index: num(p.index), rotate: num(p.rotate) % 360, w: num(p.w), h: num(p.h),
        ...(num(p.skew) && Math.abs(num(p.skew)) <= 10 ? { skew: num(p.skew), paper: /^#[0-9a-f]{6}$/i.test(p.paper) ? p.paper : '#ffffff' } : {}) })),
      pageCount: raw.pages.length, items, fields: raw.fields && typeof raw.fields === 'object' ? raw.fields : {}
    });
  }

  async function restoreBackupFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { toast('That is not a Notepad backup file.'); return; }
    if (!data || data.app !== 'notepad-online' || !Array.isArray(data.docs)) { toast('That is not a Notepad backup file.'); return; }
    let added = 0;
    let skipped = 0;
    for (const raw of data.docs) {
      if (raw && raw.type === 'pdf' && Array.isArray(raw.sources) && Array.isArray(raw.pages)) {
        const existing = docs.find((d) => d.id === raw.id);
        if (existing && existing.updated === raw.updated) { skipped++; continue; }
        try {
          const doc = restoredPdf(raw, existing ? uid() : String(raw.id || uid()));
          await NpStore.putDoc(doc);
          docs.push(doc);
          added++;
        } catch (e) { /* a damaged entry is skipped */ }
        continue;
      }
      if (!raw || typeof raw.html !== 'string') continue;
      const existing = docs.find((d) => d.id === raw.id);
      if (existing && existing.updated === raw.updated && existing.html === raw.html) { skipped++; continue; }
      const doc = Object.assign(newDocRecord(), {
        id: existing ? uid() : String(raw.id || uid()),
        title: String(raw.title || ''), titleAuto: !!raw.titleAuto || !raw.title,
        html: NpSanitize.html(raw.html), text: String(raw.text || ''), words: +raw.words || 0,
        created: +raw.created || Date.now(), updated: +raw.updated || Date.now(),
        goal: +raw.goal || 0, settings: Object.assign({}, DOC_DEFAULTS, raw.settings)
      });
      await NpStore.putDoc(doc);
      docs.push(doc);
      added++;
    }
    sortDocs();
    renderDocList();
    toast('Restored ' + added + ' document' + (added === 1 ? '' : 's') + (skipped ? ' (' + skipped + ' already here)' : ''));
  }

  $('#file-backup').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) restoreBackupFile(f);
  });

  /* =========================================================== sidebar */

  const docList = $('#doc-list');
  const docSearch = $('#doc-search');

  function renderDocList() {
    const q = docSearch.value.trim().toLowerCase();
    const list = q ? docs.filter((d) => displayTitle(d).toLowerCase().includes(q) || (d.text || '').toLowerCase().includes(q)) : docs;
    docList.replaceChildren(...list.map((d) => {
      const active = current && d.id === current.id;
      let snippet = '';
      if (q && !displayTitle(d).toLowerCase().includes(q)) {
        const t = d.text || '';
        const i = t.toLowerCase().indexOf(q);
        snippet = (i > 20 ? '…' : '') + t.slice(Math.max(0, i - 20), i + 60).replace(/\s+/g, ' ');
      }
      return el('li', { class: 'doc-item' + (active ? ' active' : '') },
        el('button', { class: 'doc-open', type: 'button', 'aria-current': active ? 'true' : null, onclick: () => openDoc(d.id) },
          el('span', { class: 'doc-name' }, d.type === 'pdf' ? el('span', { class: 'doc-badge' }, 'PDF') : null, displayTitle(d)),
          el('span', { class: 'doc-meta' }, snippet || (ago(d.updated) + ' · ' + (d.type === 'pdf'
            ? fmtNum(d.pageCount || (d.pages || []).length) + ' page' + ((d.pageCount || (d.pages || []).length) === 1 ? '' : 's')
            : fmtNum(d.words || 0) + ' word' + (d.words === 1 ? '' : 's'))))),
        el('button', { class: 'doc-del icon-btn sm', type: 'button', 'data-icon': 'trash', title: 'Delete', 'aria-label': 'Delete ' + displayTitle(d), onclick: (e) => { e.stopPropagation(); deleteDoc(d.id); } }));
    }));
    if (!list.length) docList.append(el('li', { class: 'doc-empty' }, q ? 'No documents match.' : 'No documents yet.'));
    NpIcons.inject(docList);
  }
  docSearch.addEventListener('input', debounce(renderDocList, 100));
  setInterval(() => { if (!document.hidden) renderDocList(); }, 60000);

  function setSidebar(open, transient) {
    document.body.classList.toggle('sidebar-open', open);
    if (!transient && !matchMedia('(max-width: 899px)').matches) { settings.sidebar = open; saveSettings(); }
  }

  /* =========================================================== status */

  const scheduleMetrics = debounce(refreshMetrics, 250);

  function refreshMetrics() {
    if (!current || current.type === 'pdf') return;
    const text = plainText();
    const st = stats(text);
    $('#sb-count').textContent = fmtNum(st.words) + ' word' + (st.words === 1 ? '' : 's');
    $('#sb-read').textContent = st.words ? minutes(st.read) + ' read' : '';
    editor.classList.toggle('is-empty', isEmptyDoc());
    if (settings.view === 'page') {
      const s = docSettings();
      const inch = 96;
      const mar = { narrow: 0.5, normal: 1, wide: 1.5 }[s.margins] * inch;
      const pageH = (s.paper === 'a4' ? 11.69 : 11) * inch - mar * 2;
      const pages = Math.max(1, Math.ceil((editor.scrollHeight - parseFloat(getComputedStyle(editor).paddingTop) * 2) / pageH));
      $('#sb-pages').textContent = '≈ ' + pages + ' page' + (pages === 1 ? '' : 's');
    } else $('#sb-pages').textContent = '';
    const goal = current.goal || 0;
    const meter = $('#goal-meter');
    if (goal > 0) {
      const pct = Math.min(100, (st.words / goal) * 100);
      meter.hidden = false;
      $('#goal-fill').style.width = pct + '%';
      $('#sb-goal').classList.toggle('met', pct >= 100);
      $('#goal-text').textContent = pct >= 100 ? 'Goal met' : fmtNum(st.words) + ' / ' + fmtNum(goal);
    } else {
      meter.hidden = true;
      $('#sb-goal').classList.remove('met');
      $('#goal-text').textContent = 'Set a goal';
    }
    if (current.titleAuto) {
      current.text = text;
      updateTitle();
    }
  }

  const updateSelectionCount = debounce(() => {
    const s = getSelection();
    const total = $('#sb-count');
    if (selectionInEditor() && !s.isCollapsed) {
      const n = (s.toString().match(WORD_RE) || []).length;
      const all = (plainText().match(WORD_RE) || []).length;
      total.textContent = fmtNum(n) + ' of ' + fmtNum(all) + ' words';
    } else if (/ of /.test(total.textContent)) refreshMetrics();
  }, 150);

  /* =========================================================== speech */

  let speaking = false;

  function stopSpeaking() {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    setSpeaking(false);
  }

  function setSpeaking(on) {
    speaking = on;
    $('#sb-speak').hidden = !on;
    $('#speak-label').textContent = on ? 'Stop reading' : 'Read aloud';
    if (!on && hasHighlights) CSS.highlights.delete('np-speak');
  }

  function toggleSpeak() {
    if (!('speechSynthesis' in window)) { toast('This browser cannot read text aloud.'); return; }
    if (speaking) { stopSpeaking(); return; }
    const s = getSelection();
    const useSel = selectionInEditor() && !s.isCollapsed;
    const idx = useSel ? null : textIndex();
    const text = useSel ? s.toString() : idx.text;
    if (!text.trim()) { toast('There is nothing to read yet.'); return; }
    const u = new SpeechSynthesisUtterance(text);
    const voice = speechSynthesis.getVoices().find((v) => v.name === settings.voice);
    if (voice) u.voice = voice;
    u.rate = settings.rate || 1;
    u.onend = u.onerror = () => setSpeaking(false);
    if (idx && hasHighlights) {
      u.onboundary = (ev) => {
        if (ev.name && ev.name !== 'word') return;
        const rest = idx.text.slice(ev.charIndex);
        const m = rest.match(/^[\p{L}\p{N}'’-]+/u);
        const len = ev.charLength || (m ? m[0].length : 0);
        if (!len) return;
        const r = idx.range(ev.charIndex, ev.charIndex + len);
        if (r) { CSS.highlights.set('np-speak', new Highlight(r)); scrollRangeIntoView(r); }
      };
    }
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setSpeaking(true);
  }

  /* =========================================================== views */

  function effectiveTheme() {
    if (settings.theme !== 'system') return settings.theme;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function setTheme(t) {
    settings.theme = t;
    saveSettings();
    applyTheme();
  }

  function applyTheme() {
    document.documentElement.dataset.theme = settings.theme;
    const dark = effectiveTheme() === 'dark';
    const btn = $('#theme-btn');
    btn.dataset.icon = dark ? 'sun' : 'moon';
    btn.innerHTML = '';
    delete btn.dataset.iconDone;
    NpIcons.inject(btn.parentElement);
    btn.title = dark ? 'Switch to light' : 'Switch to dark';
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  function setView(v) {
    settings.view = v;
    saveSettings();
    document.body.classList.toggle('view-page', v === 'page');
    document.body.classList.toggle('view-full', v === 'full');
    refreshMetrics();
    positionImageFrame();
  }

  function setZoom(z) {
    settings.zoom = Math.round(clamp(z, 0.5, 2) * 10) / 10;
    saveSettings();
    page.style.zoom = settings.zoom;
    $('#sb-zoom').textContent = Math.round(settings.zoom * 100) + '%';
    positionImageFrame();
  }

  function applyDocSettings() {
    const s = docSettings();
    const st = page.style;
    st.setProperty('--doc-font', fontByKey(s.font).css);
    st.setProperty('--doc-size', s.size + 'pt');
    st.setProperty('--doc-lh', String(s.lineHeight));
    st.setProperty('--paper-w', PAPER[s.paper].w);
    st.setProperty('--paper-h', PAPER[s.paper].h);
    st.setProperty('--paper-pad', MARGINS[s.margins].css);
    $('#page-rule').textContent = '@page { size: ' + PAPER[s.paper].css + '; margin: ' + MARGINS[s.margins].css + '; }';
    // until the cursor lands somewhere, the toolbar shows the document's defaults
    tbFont.value = s.font;
    tbSize.value = String(s.size);
  }

  function applySpellcheck() {
    editor.spellcheck = settings.spellcheck;
    // Browsers repaint the squiggles on the next focus.
    if (document.activeElement === editor) { editor.blur(); restoreSelection(); }
  }

  function toggleFocus() {
    const on = !document.body.classList.contains('focus');
    document.body.classList.toggle('focus', on);
    if (on) toast('Focus mode — press Esc to leave', 2000);
    restoreSelection();
  }

  /* =========================================================== boot */

  async function migrateLegacy() {
    // The first version kept one document in localStorage.
    let html = null;
    let goal = 0;
    try {
      html = localStorage.getItem('notepad_online_content');
      goal = parseInt(localStorage.getItem('notepad_online_goal'), 10) || 0;
    } catch (e) { return; }
    if (!html || !html.trim()) return;
    const doc = newDocRecord(NpSanitize.html(html, { external: true }), '');
    doc.goal = goal;
    const tmp = document.createElement('div');
    tmp.innerHTML = doc.html;
    doc.text = tmp.textContent || '';
    await NpStore.putDoc(doc);
    try {
      localStorage.removeItem('notepad_online_content');
      localStorage.removeItem('notepad_online_goal');
    } catch (e) { /* ignore */ }
    docs.push(doc);
  }

  async function boot() {
    NpIcons.inject();
    if (isMac) for (const k of $$('kbd')) k.textContent = k.textContent.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧');
    for (const b of $$('[title]')) if (isMac) b.title = b.title.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧');
    buildToolbar();
    NpPdf.init({ el, toast, dialog, changed: () => markDirty(), status: setStatus });
    applyTheme();
    setView(settings.view);
    setZoom(settings.zoom);
    applySpellcheck();
    setSidebar(settings.sidebar && !matchMedia('(max-width: 899px)').matches, true);

    const ok = await NpStore.open();
    if (!ok) {
      $('#storage-note').textContent = 'Not saving — storage blocked';
      $('#sb-foot').classList.add('warn');
      toast('This browser is blocking storage, so documents last only until the tab closes. Download your work before leaving.', 8000);
    }
    docs = await NpStore.allDocs();
    if (!docs.length) await migrateLegacy();
    sortDocs();
    const last = docs.find((d) => d.id === settings.lastDoc) || docs[0];
    if (last) await openDoc(last.id, { force: true });
    else await createDoc('', '', { keepFocus: true });
    renderDocList();
    document.body.classList.add('ready');

    // Save before the tab goes away or into the background.
    document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) saveNow(); });
    window.addEventListener('pagehide', () => { if (dirty) saveNow(); });
    window.addEventListener('beforeunload', (e) => { if (dirty && !NpStore.persistent) { e.preventDefault(); e.returnValue = ''; } });

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  boot();
})();
