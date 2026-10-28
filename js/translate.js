/* Noteshack — translation, on this computer.

   Two engines, and with either the text never leaves the computer:
   - Noteshack's own: Firefox's translation engine (Bergamot, vendor/bergamot)
     with Mozilla's models. A model is downloaded from files.noteshack.org the
     first time a pair of languages is used, checked against its fingerprint,
     and kept in this browser for next time. English is the bridge between two
     other languages (Spanish → English → French). Keeps the formatting inside
     a paragraph (bold, links…).
   - The browser's own, where there is one (Chrome's built-in translator):
     more languages, but plain text, so formatting inside a paragraph is lost.

   NpTranslate.ours(from, to)          Noteshack's engine can do it
   NpTranslate.browser(from, to)       Promise: 'available' | 'downloadable' | null
   NpTranslate.toDownload(from, to)    Promise: bytes still to download for ours
   NpTranslate.open(from, to, engine, onProgress)
                                       Promise<a translator, for translate() below>
   NpTranslate.document(html, t, opts) Promise<{ html, originals }>: each
                                       paragraph translated and marked
                                       data-np-tr="n", its original in originals[n]
   NpTranslate.unit(html, t, keep)     Promise<html>: one paragraph's contents

   opts.keep / keep: words and names to leave as they are. */
(function () {
  'use strict';

  const HOST = 'https://files.noteshack.org/translate/v1/';
  const KEEP = 'np-translate-v1'; // the downloaded models (Cache Storage)
  // pair → its files: [name, bytes, SHA-256 of the file as downloaded (gzip)]
  const MODELS = {
    enes: { model: ['model.enes.intgemm.alphas.bin.gz', 22698792, 'fe4025fde24a4d5f80533cfb7acd53d0eb7f194dfc2d8f427f0d4563cfb6ac06'], lex: ['lex.50.50.enes.s2t.bin.gz', 2265250, '37a067966f28ff0ba430fddb7412bc5b07afa2cd2fd5a46d9ad74045a1a06380'], vocab: ['vocab.enes.spm.gz', 409312, 'ae2760c04bc6eb5362b16e5c2f145c376bb04bac421c33ba3c0766805e6f03b3'] },
    esen: { model: ['model.esen.intgemm.alphas.bin.gz', 23288494, '54247f1e057180bca1d404dfd5c12836f65bc96cef7af98e59e55acb8bd093b1'], lex: ['lex.50.50.esen.s2t.bin.gz', 2543246, '3d7856bfa3b12804bdc80f12fd828fd9062c462113ab73fbf87c5c3b68420813'], vocab: ['vocab.esen.spm.gz', 409312, '1658b529b8858cf2e1e8cef2c4e2d69654d77b5f714ac52205864b336dfeb3ee'] },
    enfr: { model: ['model.enfr.intgemm.alphas.bin.gz', 23045432, '22cdaf3dc9a1da6e5818b5576737182467f3cd97e6fd6f94e4273eb7b56d1e3f'], lex: ['lex.50.50.enfr.s2t.bin.gz', 2297334, '055987f0b585b61c4914fb4469e2392fda0b25d3f7784275974f920e7b631997'], vocab: ['vocab.enfr.spm.gz', 409706, '5dcadaad8191fb4eb7677bce07098a20221dec95976a4db796f3a17cc82b4541'] },
    fren: { model: ['model.fren.intgemm.alphas.bin.gz', 23175075, '06b1eeedd3944260d00a393d12ec7192490c5b7c930b97212faf4d5f5c90a2ee'], lex: ['lex.50.50.fren.s2t.bin.gz', 2649934, '395aa7767220e1bcfc085f2b2787ff98005d0075e55451f1e0832885e3d9642a'], vocab: ['vocab.fren.spm.gz', 409706, '8d15b219ffd32327b4cabf0d94a05a4fecb8923a4f386badbcbe5e86ede453a7'] },
    ende: { model: ['model.ende.intgemm.alphas.bin.gz', 22992073, 'e3a74458faba3ab2752ed8355c5e3979f13395279c8fc1bd3f54a3c2316e4975'], lex: ['lex.50.50.ende.s2t.bin.gz', 2314750, '0370d79cda6fed5dfa8f9b2a0009459bd2766893825bb5b8b5114169d18da6c4'], vocab: ['vocab.ende.spm.gz', 413879, '3b2ddbfac73f994f151a8994447d6b3d41ab0d3435da56f79c233f34d03e45c2'] },
    deen: { model: ['model.deen.intgemm.alphas.bin.gz', 22403755, '38b245bcfc23f6d61fd98a187436ea1320a38f41896df411b103df3e83f51681'], lex: ['lex.50.50.deen.s2t.bin.gz', 2626658, '231e9caf62e0e867775d5f4c1f4cfae21e37c70d9bf2bd628fa468aeeb2ba869'], vocab: ['vocab.deen.spm.gz', 413879, '88dcd7fdbf20dc60837ce837244d0d55b20f7079f2cbd2ba8e63530632028310'] },
    enpt: { model: ['model.enpt.intgemm.alphas.bin.gz', 23340019, 'afb5ae08a2e40b622cd191584cca1df00721fea43de85cec74191fc180370f08'], lex: ['lex.50.50.enpt.s2t.bin.gz', 2117608, '265cff4ca31d3fc95628181de98cf668868b44903d69680284dc456aa4191545'], vocab: ['vocab.enpt.spm.gz', 408686, 'c2fbaf26f10563c77fa95cca465ad3666f61dd08bfaef5bb170abd582901f389'] },
    pten: { model: ['model.pten.intgemm.alphas.bin.gz', 22700409, 'f2d2bb46d452cef561d35504bd198fa6c6ffc47187ee987406a2ac05d9c3935f'], lex: ['lex.50.50.pten.s2t.bin.gz', 2487847, 'b31185389533a97177cbf68ea756b78bfbaa24d31a865d72c6ed203fa414b2f6'], vocab: ['vocab.pten.spm.gz', 408686, '28c9eb4fb13f8eb661f6bb098560a1bf368d25ff890275028ea9d4f3f97b0416'] },
    enit: { model: ['model.enit.intgemm.alphas.bin.gz', 23892889, 'cfff470e9f29e27132723589a8bc985648f92773410e5f6fc43293d9e19f97f1'], lex: ['lex.50.50.enit.s2t.bin.gz', 2209348, 'cd7ef06c0b872c15286a9796f105eb62693f14665490546ac70ce1c6c8f16d47'], vocab: ['vocab.enit.spm.gz', 407598, '8f99a6f493bf7e1a03fbba19928d7dc7bf9a1b7938238467f3e80a58c0d50485'] },
    iten: { model: ['model.iten.intgemm.alphas.bin.gz', 23301774, '0bc7221c2730723ac4477e8aa1d1d5bd0b9c3450cb8d006a6f86fe5da9129c27'], lex: ['lex.50.50.iten.s2t.bin.gz', 2532929, '504877085b31edfa3d31a1918a9a42c20fcbf85ff018caf46c54641db5538e62'], vocab: ['vocab.iten.spm.gz', 407598, 'df05fae498f519a828eb388cd08ec1b7205a8bcaf2405a5feb9f5e30c49a0977'] },
  };

  const base = (code) => String(code || '').split('-')[0];
  // the models a pair needs, through English if there is no direct one
  function route(from, to) {
    const f = base(from), t = base(to);
    if (f === t) return null;
    if (MODELS[f + t]) return [f + t];
    if (MODELS[f + 'en'] && MODELS['en' + t]) return [f + 'en', 'en' + t];
    return null;
  }
  const urlOf = (pair, file) => HOST + pair.slice(0, 2) + '-' + pair.slice(2) + '/' + file[0];
  const ALL = new Map(Object.entries(MODELS).flatMap(([p, fs]) => Object.values(fs).map((f) => [urlOf(p, f), { url: urlOf(p, f), size: f[1], sha: f[2] }])));
  const filesOf = (from, to) => (route(from, to) || []).flatMap((p) => Object.values(MODELS[p]).map((f) => ALL.get(urlOf(p, f))));

  async function kept(url) {
    try { return await (await caches.open(KEEP)).match(url); } catch (e) { return null; }
  }

  async function toDownload(from, to) {
    let n = 0;
    for (const f of filesOf(from, to)) if (!(await kept(f.url))) n += f.size;
    return n;
  }

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  // A model file, downloaded once and kept; unpacked here (the engine takes
  // it unpacked). onBytes(n) as it arrives.
  async function getFile(f, onBytes) {
    const k = await kept(f.url);
    let gz = k ? await k.arrayBuffer() : null;
    if (gz) onBytes(f.size);
    else {
      const res = await fetch(f.url, { credentials: 'omit' });
      if (!res.ok) throw new Error('Could not download the translation model (' + res.status + ').');
      const chunks = [];
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onBytes(got);
      }
      gz = await new Blob(chunks).arrayBuffer();
      if (hex(await crypto.subtle.digest('SHA-256', gz)) !== f.sha) throw new Error('The translation model did not download correctly. Try again.');
      try { await (await caches.open(KEEP)).put(f.url, new Response(gz, { headers: { 'content-type': 'application/gzip' } })); } catch (e) { /* used this time only */ }
    }
    return new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }

  // Downloads (or finds kept) what a pair needs, with progress (0…1).
  const ready = new Map(); // url → Promise<ArrayBuffer>, until the engine takes it
  async function fetchModels(from, to, onProgress) {
    const files = filesOf(from, to);
    const total = files.reduce((n, f) => n + f.size, 0);
    const got = new Map();
    const tell = () => onProgress && onProgress([...got.values()].reduce((a, b) => a + b, 0) / total);
    await Promise.all(files.map((f) => {
      if (!ready.has(f.url)) {
        ready.set(f.url, getFile(f, (n) => { got.set(f.url, n); tell(); }));
        ready.get(f.url).catch(() => ready.delete(f.url));
      } else got.set(f.url, f.size);
      return ready.get(f.url);
    }));
    tell();
  }

  /* ----- Noteshack's engine ----- */

  let engine = null; // Promise<BatchTranslator>
  let broken = null; // why the engine stopped
  const pending = new Set(); // { reject } of translations not yet back

  function failAll(err) {
    broken = err instanceof Error ? err : new Error((err && err.message) || 'The translator stopped.');
    for (const p of pending) p.reject(broken);
    pending.clear();
    const e = engine;
    engine = null;
    if (e) e.then((t) => t.delete()).catch(() => {});
  }

  function loadEngine() {
    if (!engine) {
      broken = null;
      engine = (async () => {
        const B = await import(new URL('vendor/bergamot/translator.js', document.baseURI).href);
        class Backing extends B.TranslatorBacking {
          async loadModelRegistery() {
            return Object.entries(MODELS).map(([pair, files]) => ({
              from: pair.slice(0, 2), to: pair.slice(2),
              files: Object.fromEntries(Object.entries(files).map(([part, f]) => [part, { name: urlOf(pair, f), size: f[1], expectedSha256Hash: f[2] }]))
            }));
          }
          async fetch(url) {
            if (!ready.has(url)) ready.set(url, getFile(ALL.get(url), () => {}));
            const p = ready.get(url);
            ready.delete(url); // the engine keeps its own copy from here
            return p;
          }
        }
        // (the options are copied into the engine's worker, so no functions in them)
        const options = { workers: 1, batchSize: 8, cacheSize: 0, useNativeIntGemm: false, downloadTimeout: 0, pivotLanguage: 'en' };
        const backing = new Backing(options);
        backing.onerror = failAll;
        const t = new B.BatchTranslator(options, backing);
        t.onerror = failAll;
        return t;
      })();
      engine.catch(failAll);
    }
    return engine;
  }

  async function openOurs(from, to, onProgress) {
    await fetchModels(from, to, onProgress);
    const t = await loadEngine();
    const f = base(from), g = base(to);
    return {
      markup: true,
      translate: (html) => new Promise((resolve, reject) => {
        if (broken) { reject(broken); return; }
        const p = { reject };
        pending.add(p);
        t.translate({ from: f, to: g, text: html, html: true }).then((r) => { pending.delete(p); resolve(r.target.text); },
          (e) => { pending.delete(p); reject(broken || e); });
      }),
      close() {}
    };
  }

  /* ----- the browser's engine ----- */

  const bcp = (code) => (code === 'zh-Hans' ? 'zh' : code);

  async function browser(from, to) {
    if (!('Translator' in self) || base(from) === base(to)) return null;
    try {
      const a = await self.Translator.availability({ sourceLanguage: bcp(from), targetLanguage: bcp(to) });
      return a === 'available' ? 'available' : (a === 'downloadable' || a === 'downloading') ? 'downloadable' : null;
    } catch (e) { return null; }
  }

  async function openBrowser(from, to, onProgress) {
    const t = await self.Translator.create({
      sourceLanguage: bcp(from), targetLanguage: bcp(to),
      monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress && onProgress(e.total ? e.loaded / e.total : e.loaded)); }
    });
    if (onProgress) onProgress(1);
    return { markup: false, translate: (text) => t.translate(text), close: () => { try { t.destroy(); } catch (e) { /* gone */ } } };
  }

  function open(from, to, engineName, onProgress) {
    return engineName === 'browser' ? openBrowser(from, to, onProgress) : openOurs(from, to, onProgress);
  }

  /* ----- documents ----- */

  const BLOCK = /^(P|H[1-6]|LI|TD|TH|BLOCKQUOTE|DIV|DT|DD|FIGCAPTION|CAPTION|UL|OL|DL|TABLE|THEAD|TBODY|TFOOT|TR|FIGURE|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|HR|PRE|ADDRESS|DETAILS|SUMMARY)$/;
  // left exactly as they are: pictures, code, and anything marked so
  const PROTECT = 'img,input,code,kbd,samp,var,svg,math,video,audio,iframe,object,[translate="no"],[contenteditable="false"]';
  // a document that shows nothing and loads nothing, to take HTML apart in
  const inert = document.implementation.createHTMLDocument('');
  const hasWords = (n) => /\p{L}/u.test(n.textContent);
  const skipped = (el) => el.tagName === 'PRE' || el.matches(PROTECT);

  // The paragraphs: blocks holding only inline content. Inline text sitting
  // beside blocks (a list item with a list inside it) is wrapped in a span
  // to make a paragraph of its own.
  function units(root) {
    const out = [];
    (function walk(node, isRoot) {
      if (!isRoot && skipped(node)) return;
      const kids = [...node.childNodes];
      const isBlock = (k) => k.nodeType === 1 && BLOCK.test(k.tagName);
      if (!isRoot && !kids.some(isBlock)) { if (hasWords(node)) out.push(node); return; }
      let run = [];
      const flush = () => {
        if (run.some((k) => (k.nodeType === 3 || (k.nodeType === 1 && !skipped(k))) && hasWords(k))) {
          const s = node.ownerDocument.createElement('span');
          run[0].before(s);
          s.append(...run);
          out.push(s);
        }
        run = [];
      };
      for (const k of kids) { if (isBlock(k)) { flush(); walk(k, false); } else if (k.nodeType === 1 || k.nodeType === 3) run.push(k); }
      flush();
    })(root, true);
    return out;
  }

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Swaps what must not be translated for numbered stand-ins.
  function protect(box, keep, plain) {
    const saved = [];
    const stand = (node) => {
      const i = saved.length;
      const ph = box.ownerDocument.createElement('img');
      ph.setAttribute('data-np-k', i);
      saved.push({ node, ph });
      return ph;
    };
    for (const el of [...box.querySelectorAll(PROTECT)]) {
      if (!box.contains(el) || (el.parentElement !== box && el.parentElement.closest(PROTECT) && box.contains(el.parentElement.closest(PROTECT)))) continue;
      el.replaceWith(stand(el));
    }
    if (plain) for (const br of [...box.querySelectorAll('br')]) br.replaceWith(stand(br));
    const words = (keep || []).map((w) => String(w).trim()).filter(Boolean).sort((a, b) => b.length - a.length);
    if (words.length) {
      const re = new RegExp('(?<![\\p{L}\\p{N}])(' + words.map(escRe).join('|') + ')(?![\\p{L}\\p{N}])', 'gu');
      const walker = box.ownerDocument.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      const texts = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
      for (const t of texts) {
        const v = t.nodeValue;
        re.lastIndex = 0;
        if (!re.test(v)) continue;
        const parts = [];
        let at = 0;
        v.replace(re, (m, w, i) => { parts.push(v.slice(at, i), stand(box.ownerDocument.createTextNode(m))); at = i + m.length; return m; });
        parts.push(v.slice(at));
        t.replaceWith(...parts.filter((p) => p !== ''));
      }
    }
    // whether a space stood either side, to put it back if the engine drops it
    for (const s of saved) {
      const prev = s.ph.previousSibling, next = s.ph.nextSibling;
      s.before = !!(prev && /\s$/.test(prev.textContent));
      s.after = !!(next && /^\s/.test(next.textContent));
    }
    return saved;
  }

  function restore(box, saved) {
    for (const ph of [...box.querySelectorAll('img[data-np-k]')]) {
      const s = saved[+ph.getAttribute('data-np-k')];
      if (!s) { ph.remove(); continue; }
      const prev = ph.previousSibling, next = ph.nextSibling;
      if (s.after && next && next.nodeType === 3 && /^[\p{L}\p{N}]/u.test(next.nodeValue)) next.nodeValue = ' ' + next.nodeValue;
      if (s.before && prev && prev.nodeType === 3 && /[\p{L}\p{N},;:]$/u.test(prev.nodeValue)) prev.nodeValue += ' ';
      if (next && next.nodeType === 3) next.nodeValue = next.nodeValue.replace(/^\s{2,}/, ' ');
      if (prev && prev.nodeType === 3) prev.nodeValue = prev.nodeValue.replace(/\s{2,}$/, ' ');
      ph.replaceWith(s.node);
      s.used = true;
    }
    // anything the engine lost goes at the end rather than vanishing
    for (const s of saved) if (!s.used) box.append(' ', s.node);
  }

  // One paragraph's contents (HTML) → translated (HTML).
  async function unit(html, t, keep) {
    const box = inert.createElement('div');
    box.innerHTML = html;
    if (!hasWords(box)) return html;
    const saved = protect(box, keep, !t.markup);
    if (!hasWords(box)) return html;
    if (t.markup) {
      box.innerHTML = await t.translate(box.innerHTML);
    } else {
      // plain text: the pieces between the stand-ins, each on its own
      const parts = [];
      let text = '';
      const flush = () => { if (text) parts.push(text); text = ''; };
      const walker = inert.createTreeWalker(box, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 3) text += n.nodeValue;
        else if (n.matches('img[data-np-k]')) { flush(); parts.push(n); }
      }
      flush();
      const out = await Promise.all(parts.map(async (p) => {
        if (typeof p !== 'string') return p;
        if (!/\p{L}/u.test(p)) return inert.createTextNode(p);
        const lead = p.match(/^\s*/)[0], trail = p.match(/\s*$/)[0];
        return inert.createTextNode(lead + (await t.translate(p.trim())) + trail);
      }));
      box.replaceChildren(...out);
    }
    restore(box, saved);
    return box.innerHTML;
  }

  // A whole document: every paragraph, the engine taking them in batches.
  // onUnit(done, total) as they come back.
  async function translateDocument(html, t, opts = {}) {
    const root = inert.createElement('div');
    root.innerHTML = html;
    const list = units(root);
    const originals = [];
    let done = 0;
    if (opts.onUnit) opts.onUnit(0, list.length);
    await Promise.all(list.map(async (u, i) => {
      originals[i] = u.innerHTML;
      u.innerHTML = await unit(u.innerHTML, t, opts.keep);
      u.setAttribute('data-np-tr', i);
      done++;
      if (opts.onUnit) opts.onUnit(done, list.length);
    }));
    return { html: root.innerHTML, originals };
  }

  window.NpTranslate = {
    ours: (from, to) => !!route(from, to),
    browser, toDownload, open, unit,
    document: translateDocument,
    // the languages Noteshack's engine translates between
    languages: () => [...new Set(Object.keys(MODELS).flatMap((p) => [p.slice(0, 2), p.slice(2)]))]
  };
})();
