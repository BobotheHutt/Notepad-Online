/* Noteshack — text in any script, on screen and in saved PDFs.

   A PDF's own fonts and the matched ones hold Western letters only. Text in
   other scripts (Arabic, Hebrew, Indic scripts, Thai, Chinese, Japanese,
   Korean, and Cyrillic, Greek or Vietnamese where the font has no such
   letters) is written in Noto, from files.noteshack.org: downloaded the first
   time a script is used and kept (js/remote.js).

   In a saved PDF the line is put in order (the Unicode bidirectional
   algorithm, vendor/bidi), each run shaped by HarfBuzz (vendor/harfbuzz):
   Arabic letters joined, Indic conjuncts and vowel signs formed, marks placed.
   Only the letters used go into the file (HarfBuzz's subsetter), with a map
   back to the text, so the PDF can still be searched and copied.

   NpShape.needs(text, simple)     whether a line needs this: simple(ch) gives
                                   the PDF font that can write ch, or null
   NpShape.writer(pdfDoc, PDFLib)  draws lines into a document being saved:
     w.draw(page, text, o)         Promise<width>; o: { toPdf(x, y), R, x,
                                   base, size, color, scaleX, invisible,
                                   family, bold, italic, lang, simple }
     w.finish()                    embeds the fonts, once every page is drawn
   NpShape.prepare(text, o)        Promise<true when fonts were added>: the
                                   Noto fonts the text needs, for the screen
   NpShape.css(lang)               the CSS family names, to follow a font */
(function () {
  'use strict';
  const _ = NpI18n.t; // the app's own language (js/i18n.js)

  const HOST = 'https://files.noteshack.org/fonts/v1/';
  const KEEP = 'np-fonts-noto-v1';
  // family → style → [file, bytes, SHA-256 of the file as downloaded (gzip)]
  const FONTS = {
    NotoSans: { Regular: ['NotoSans-Regular.ttf.gz', 295668, '49f2e3bd32ff4c2ff39da9ffd0c4aa3b238e18c6a2dabf5042ca9aa067f560ed'], Bold: ['NotoSans-Bold.ttf.gz', 306089, '976ab6a29f9103d6c844c42e49fad0b13dbe29685437fa19d03bc6241459b729'], Italic: ['NotoSans-Italic.ttf.gz', 304236, '7a5b16151f6b41ff0daab0d4cae5d22df2822974bf761f7e3120f9f86da830ca'], BoldItalic: ['NotoSans-BoldItalic.ttf.gz', 312511, 'b95964132c9756a4a9a42b9ab7871b77b1ac2bdd213b2dceb076c8230747e2e8'] },
    NotoSerif: { Regular: ['NotoSerif-Regular.ttf.gz', 243344, '4d88564aab43b7f2c0edbcd0fe30da0db3c476566d112d72ad8788decb685f08'], Bold: ['NotoSerif-Bold.ttf.gz', 255813, '3df6798654777a1e322f3c01b89229ecd99fbad5f2177fe0872c74b145772d09'], Italic: ['NotoSerif-Italic.ttf.gz', 267460, '778252bfeaa11488515ae312160929a345ef0727f2b8a7efac887c2b18e4afcb'], BoldItalic: ['NotoSerif-BoldItalic.ttf.gz', 272185, 'e03c19d66f48f12483c90f3325cfa6b67d7ba39d6cbd0efaf9bbc8118d22c6a1'] },
    NotoSansMono: { Regular: ['NotoSansMono-Regular.ttf.gz', 214300, 'a076842e8f69602904024f40b8576f47d265ebb1d573001e0baf06825e36c464'], Bold: ['NotoSansMono-Bold.ttf.gz', 216053, 'f412cd896b3e43cd5d122e615457031c333dcbced7b148a49594056484d34a9f'] },
    NotoSansArabic: { Regular: ['NotoSansArabic-Regular.ttf.gz', 88497, 'e63838746d3c37fdabd8db42dea10ea4c36c04aa9a356b2593c67f71e3113b67'], Bold: ['NotoSansArabic-Bold.ttf.gz', 89751, '346a12c8f6571e13bccabde5b5afff971a74a093ecafe425688e2f093f7b1458'] },
    NotoSansHebrew: { Regular: ['NotoSansHebrew-Regular.ttf.gz', 27635, '4c5a7734cdeb783e75f60a8be2defc0eea2c1b72066af4c6e4a9c7cb54bff509'], Bold: ['NotoSansHebrew-Bold.ttf.gz', 27687, '484659b6d18b8c82510f3fda46cd93f5ee34306dd814e9eb0341caf6b8ea0a30'] },
    NotoSansDevanagari: { Regular: ['NotoSansDevanagari-Regular.ttf.gz', 87795, '82032a154e901551b53efe9803a55bf4e39bcbc573d82725b329ebc6aab956c1'], Bold: ['NotoSansDevanagari-Bold.ttf.gz', 91609, '54d4cf7aae7609a0866764c5a5cb55958f8b1c1170b5c64392f4105886cf6744'] },
    NotoSansBengali: { Regular: ['NotoSansBengali-Regular.ttf.gz', 73181, 'ba669e03c8b8e2146512045cbcb19be1a5ec6af1d1b112dfe37cf1d9e4ac97d2'], Bold: ['NotoSansBengali-Bold.ttf.gz', 76981, '52b8b62392e02dec9c45f63b57880f3e74d8cd8bdae6455191de9bf7e683fd20'] },
    NotoSansTamil: { Regular: ['NotoSansTamil-Regular.ttf.gz', 38766, 'fdd15d7ef5de1b99a336851197270a54f0ef0f2031a6a1ab1ee38886ca48411d'], Bold: ['NotoSansTamil-Bold.ttf.gz', 38986, '0ad593bd7dc97d9bbba2ee56f3063f6be9c71efebd393dc0437417a2c9947aeb'] },
    NotoSansTelugu: { Regular: ['NotoSansTelugu-Regular.ttf.gz', 69943, 'a5998a908593b28261996f672cde1b9ccea16bb5360655977075863cdbdc774f'], Bold: ['NotoSansTelugu-Bold.ttf.gz', 71172, '2dffd1ffbd6e7c7074f411d0dc241b8c2b423aa61b1396d9c111c26bd5ad9569'] },
    NotoSansGujarati: { Regular: ['NotoSansGujarati-Regular.ttf.gz', 70454, '468d267851aead4a43cf749e020e011921b165fe0be184cb158de19b35db52d7'], Bold: ['NotoSansGujarati-Bold.ttf.gz', 70797, 'ac0e75b0af89b7ee11b2d26ba2dea3b9e90669db3419c6e9880ccb6e537d21b7'] },
    NotoSansGurmukhi: { Regular: ['NotoSansGurmukhi-Regular.ttf.gz', 31619, '00642ff6b4494b7f469f2f9b0f2a2cbd6ea2dd7c544ec3d70f36eaba161ef58d'], Bold: ['NotoSansGurmukhi-Bold.ttf.gz', 31719, '3ce04269ac28a767ef1c60948c1c8a7ac0c83c06dd2db5663e7ad244e58ac324'] },
    NotoSansThai: { Regular: ['NotoSansThai-Regular.ttf.gz', 27512, '00ec549132ee96456a48239047b67e8b171cbebafc532d7be002431a266c76b7'], Bold: ['NotoSansThai-Bold.ttf.gz', 27417, 'cee2ac3ac02ce11a299f80d4e257173ab60193433dc39a7ab88e1e651c8809d2'] },
    NotoSansSC: { Regular: ['NotoSansSC-Regular.ttf.gz', 6287563, 'dee0c6e18f4440743d612a8b8f38302aeb594022d645eeb1a328dcec1b255ef4'], Bold: ['NotoSansSC-Bold.ttf.gz', 6365591, '7bb05fc0b929a20c71191d04040c3b49a963cd9804ec5ae8d8da08d218dceb30'] },
    NotoSansTC: { Regular: ['NotoSansTC-Regular.ttf.gz', 4250865, '8e5e0e2918b8a4d8e7fd3b6cb027c31f7fa9e330b1b90cad547052309cbe0f45'], Bold: ['NotoSansTC-Bold.ttf.gz', 4306161, '5e858753a37caa42bbeaf7a7936414f6ac121316b29d31c6f8353e95dda18f5a'] },
    NotoSansJP: { Regular: ['NotoSansJP-Regular.ttf.gz', 3300334, '1720b5de10a9e9c58234ac02524a52f4a561c4e83f1a8eb2e4ca00c899c12838'], Bold: ['NotoSansJP-Bold.ttf.gz', 3335182, '813e61d32f4d714612b6d6098d88535b1aa52d47dcc374cef2590951927f5324'] },
    NotoSansKR: { Regular: ['NotoSansKR-Regular.ttf.gz', 3000699, '942ba56ff80d6ba52093676bb0b56185583d4035864f106fda67f8351c9a2859'], Bold: ['NotoSansKR-Bold.ttf.gz', 3039011, '70e058320b75b9c70b25177d7a96cca2299a242bd3c1a64b45b96640020c8ab4'] },
  };

  // the scripts written in a font of their own
  const SCRIPTS = [
    [/\p{Script=Arabic}/u, 'NotoSansArabic'], [/\p{Script=Hebrew}/u, 'NotoSansHebrew'],
    [/\p{Script=Devanagari}/u, 'NotoSansDevanagari'], [/\p{Script=Bengali}/u, 'NotoSansBengali'],
    [/\p{Script=Tamil}/u, 'NotoSansTamil'], [/\p{Script=Telugu}/u, 'NotoSansTelugu'],
    [/\p{Script=Gujarati}/u, 'NotoSansGujarati'], [/\p{Script=Gurmukhi}/u, 'NotoSansGurmukhi'],
    [/\p{Script=Thai}/u, 'NotoSansThai'], [/\p{Script=Hangul}/u, 'NotoSansKR'],
    [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'kana'], [/\p{Script=Han}/u, 'han']
  ];
  const COMPLEX = new RegExp(SCRIPTS.map(([re]) => re.source).join('|'), 'u');
  const NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u;
  // Chinese characters take the shapes of the document's language
  const han = (lang) => (/^ja/.test(lang) ? 'NotoSansJP' : /^ko/.test(lang) ? 'NotoSansKR' : /^zh-(Hant|TW|HK)/i.test(lang) ? 'NotoSansTC' : 'NotoSansSC');
  const BASE = { sans: 'NotoSans', serif: 'NotoSerif', mono: 'NotoSansMono' };

  function familyOf(ch, o) {
    for (const [re, fam] of SCRIPTS) {
      if (!re.test(ch)) continue;
      if (fam === 'han') return han(o.lang || '');
      if (fam === 'kana') return /^zh/.test(o.lang || '') ? han(o.lang) : 'NotoSansJP';
      return fam;
    }
    return BASE[o.family || 'sans'] || 'NotoSans';
  }
  function styleOf(fam, o) {
    const s = (o.bold ? 'Bold' : '') + (o.italic && FONTS[fam].Italic ? 'Italic' : '');
    return FONTS[fam][s || 'Regular'] ? (s || 'Regular') : 'Regular';
  }

  /* ----- fonts ----- */

  const fileOf = (key) => { const [fam, style] = key.split('-'); const f = FONTS[fam][style]; return { url: HOST + fam + '/' + f[0], size: f[1], sha: f[2] }; };
  const bytesOf = new Map(); // 'Family-Style' → Promise<ArrayBuffer>
  function fontBytes(key) {
    if (!bytesOf.has(key)) {
      bytesOf.set(key, NpRemote.get(fileOf(key), KEEP, null, {
        failed: (status) => _('Could not download a font for this text ({status}).', { status }),
        damaged: _('A font for this text did not download correctly. Try again.')
      }));
      bytesOf.get(key).catch(() => bytesOf.delete(key));
    }
    return bytesOf.get(key);
  }

  let hbLib = null;
  const harfbuzz = () => hbLib || (hbLib = import(new URL('vendor/harfbuzz/index.mjs', document.baseURI).href));
  const hbFonts = new Map(); // key → Promise<{ font, upem, bytes }>
  function hbFont(key) {
    if (!hbFonts.has(key)) {
      hbFonts.set(key, (async () => {
        const [hb, bytes] = await Promise.all([harfbuzz(), fontBytes(key)]);
        const face = new hb.Face(new hb.Blob(bytes));
        return { hb, font: new hb.Font(face), upem: face.upem, bytes: new Uint8Array(bytes) };
      })());
      hbFonts.get(key).catch(() => hbFonts.delete(key));
    }
    return hbFonts.get(key);
  }

  let bidiLib = null;
  function bidi() {
    if (!bidiLib) {
      bidiLib = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/bidi/bidi.min.js';
        s.onload = () => resolve(window.bidi_js());
        s.onerror = () => reject(new Error(_('Could not load the text tools. Check your connection and try again.')));
        document.head.append(s);
      });
      bidiLib.catch(() => { bidiLib = null; });
    }
    return bidiLib;
  }

  /* ----- a line, in runs ----- */

  // Which font each piece of a line is written in, and in what order the
  // pieces stand: runs of one direction and one font, in visual order.
  async function runsOf(text, o) {
    const B = await bidi();
    const { levels } = B.getEmbeddingLevels(text, o.dir === 'rtl' ? 'rtl' : o.dir === 'ltr' ? 'ltr' : undefined);
    // code points, with their place in the text and their level
    const cps = [];
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i);
      const n = cp > 0xffff ? 2 : 1;
      cps.push({ i, n, ch: String.fromCodePoint(cp), level: levels[i] });
      i += n;
    }
    // the PDF's own fonts that can write a character: S0, S1…
    const simples = o.simples || (o.simples = []);
    const simpleKey = (ch) => {
      const sf = o.simple && o.simple(ch);
      if (!sf) return null;
      if (!simples.includes(sf)) simples.push(sf);
      return 'S' + simples.indexOf(sf);
    };
    const notoKey = (ch) => { const fam = familyOf(ch, o); return fam + '-' + styleOf(fam, o); };
    const baseKey = () => { const fam = BASE[o.family || 'sans'] || 'NotoSans'; return fam + '-' + styleOf(fam, o); };
    const keyOf = (ch) => (!COMPLEX.test(ch) && simpleKey(ch)) || notoKey(ch);
    for (const c of cps) c.key = NEUTRAL.test(c.ch) ? null : keyOf(c.ch);
    // spaces, digits and punctuation go with the text around them
    for (let k = 0; k < cps.length; k++) {
      if (cps[k].key) continue;
      let j = k - 1;
      while (j >= 0 && (!cps[j].key || cps[j].level !== cps[k].level)) j--;
      let m = k + 1;
      while (m < cps.length && (!cps[m].key || cps[m].level !== cps[k].level)) m++;
      const near = j >= 0 ? cps[j].key : m < cps.length ? cps[m].key : null;
      cps[k].key = near || keyOf(cps[k].ch);
    }
    // a font that lacks a character hands it on: to the PDF's font if it can
    // write it, else to Noto for the item's family
    for (const c of cps) {
      if (c.key[0] === 'S') { c.key = simpleKey(c.ch) || notoKey(c.ch); if (c.key[0] === 'S') continue; }
      const f = await hbFont(c.key);
      if (f.font.nominalGlyph(c.ch.codePointAt(0)) === undefined && !/\s/.test(c.ch)) c.key = simpleKey(c.ch) || baseKey();
    }
    // a word with a letter only Noto has (tiếng, Ελληνικά) is written in it
    // whole, not in two fonts
    for (let a = 0; a < cps.length;) {
      let b = a;
      while (b < cps.length && !/\s/.test(cps[b].ch)) b++;
      const noto = cps.slice(a, b).find((c) => c.key[0] !== 'S' && Object.values(BASE).some((fam) => c.key.startsWith(fam + '-')));
      if (noto) for (let q = a; q < b; q++) if (cps[q].key[0] === 'S' && cps[q].level === noto.level) cps[q].key = noto.key;
      a = b + 1;
    }
    const runs = [];
    for (const c of cps) {
      const last = runs[runs.length - 1];
      if (last && last.key === c.key && last.level === c.level) { last.end = c.i + c.n; continue; }
      runs.push({ key: c.key, level: c.level, start: c.i, end: c.i + c.n });
    }
    for (const r of runs) r.text = text.slice(r.start, r.end);
    // visual order: from the highest level down to the lowest odd one, each
    // stretch of runs at that level or above is reversed
    const max = Math.max(0, ...runs.map((r) => r.level));
    const minOdd = Math.min(...runs.map((r) => (r.level % 2 ? r.level : Infinity)));
    for (let lv = max; lv >= minOdd && lv > 0; lv--) {
      for (let a = 0; a < runs.length;) {
        if (runs[a].level < lv) { a++; continue; }
        let b = a;
        while (b < runs.length && runs[b].level >= lv) b++;
        runs.splice(a, b - a, ...runs.slice(a, b).reverse());
        a = b;
      }
    }
    return runs;
  }

  // A run shaped: glyphs in visual order, with where each stands (font units).
  async function shapeRun(r, o) {
    const f = await hbFont(r.key);
    const buf = new f.hb.Buffer();
    buf.addText(r.text);
    buf.guessSegmentProperties();
    buf.setDirection(r.level % 2 ? f.hb.Direction.RTL : f.hb.Direction.LTR);
    if (o.lang) buf.setLanguage(o.lang);
    f.hb.shape(f.font, buf);
    const glyphs = buf.getGlyphInfosAndPositions();
    let pen = 0;
    const out = glyphs.map((g) => {
      const q = { gid: g.codepoint, cluster: g.cluster, x: pen + (g.xOffset || 0), y: g.yOffset || 0, adv: g.xAdvance || 0 };
      pen += g.xAdvance || 0;
      return q;
    });
    // The text each glyph stands for: its cluster (to the next one), on the
    // cluster's widest glyph, the letter's body; its marks and pieces (dots,
    // a vowel sign drawn before the letter) stand for nothing of their own.
    const starts = [...new Set(out.map((g) => g.cluster))].sort((a, b) => a - b);
    const body = new Map();
    for (const g of out) if (!body.has(g.cluster) || g.adv > body.get(g.cluster).adv) body.set(g.cluster, g);
    for (const g of out) {
      const next = starts.find((s) => s > g.cluster);
      g.text = body.get(g.cluster) === g ? r.text.slice(g.cluster, next === undefined ? r.text.length : next) : '';
    }
    return { f, glyphs: out, advance: pen };
  }

  /* ----- writing into a PDF ----- */

  function needs(text, simple) {
    for (const ch of String(text || '')) {
      if (/\s/.test(ch)) continue;
      if (COMPLEX.test(ch) || !simple(ch)) return true;
    }
    return false;
  }

  // a TJ operand: glyphs, and the moves between them (rounded; zeros left out)
  function arrayOf(ctx, L, parts) {
    const arr = L.PDFArray.withContext(ctx);
    for (const q of parts) {
      if (typeof q === 'number') { const v = Math.round(q * 100) / 100; if (v) arr.push(L.PDFNumber.of(v)); } else arr.push(q);
    }
    return arr;
  }

  // Each glyph, with what it stands for, has a character id of its own: one
  // glyph can be part of several letters (Arabic letters share a body and
  // differ in their dots), and the PDF says what each id stands for.
  // (zero: an invisible stand-in with no width; see below)
  function cidOf(u, gid, text, zero) {
    const k = gid + ':' + text + (zero ? ':0' : '');
    if (!u.cids.has(k)) {
      u.cids.set(k, u.gidOf.length);
      u.gidOf.push(gid);
      u.textOf.push(text);
      if (zero) u.zero.add(u.gidOf.length - 1);
    }
    return u.cids.get(k);
  }

  function writer(doc, L) {
    const used = new Map(); // key → { ref, name, gids: Map(gid → text), f }
    const keysOnPage = new WeakMap(); // page → Map(key → resource name)
    const tag = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

    function fontOn(page, key, f) {
      if (!used.has(key)) used.set(key, { ref: doc.context.nextRef(), name: tag() + '+' + key, cids: new Map(), gidOf: [0], textOf: [''], zero: new Set(), f });
      const u = used.get(key);
      if (!keysOnPage.has(page)) keysOnPage.set(page, new Map());
      const m = keysOnPage.get(page);
      if (!m.has(key)) m.set(key, page.node.newFontDictionary(u.name, u.ref));
      return { u, res: m.get(key) };
    }

    async function draw(page, text, o) {
      const runs = await runsOf(text, o);
      const sx = o.scaleX || 1;
      const rad = ((o.R || 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      let x = o.x;
      for (const r of runs) {
        if (r.key[0] === 'S') {
          const font = o.simples[+r.key.slice(1)];
          const [px, py] = o.toPdf(x, o.base);
          if (o.invisible) {
            const key = page.node.newFontDictionary(font.name, font.ref);
            page.pushOperators(L.pushGraphicsState(), L.beginText(), L.setFontAndSize(key, o.size), L.setTextRenderingMode(L.TextRenderingMode.Invisible),
              L.setTextMatrix(cos * sx, sin * sx, -sin, cos, px, py), L.showText(font.encodeText(r.text)), L.endText(), L.popGraphicsState());
          } else {
            if (sx !== 1) page.pushOperators(L.pushGraphicsState(), L.setCharacterSqueeze(sx * 100));
            page.drawText(r.text, { x: px, y: py, size: o.size, font, color: o.color, rotate: L.degrees(o.R || 0) });
            if (sx !== 1) page.pushOperators(L.popGraphicsState());
          }
          x += font.widthOfTextAtSize(r.text, o.size) * sx;
          continue;
        }
        const s = await shapeRun(r, o);
        const k = o.size / s.f.upem;
        const em = 1000 / s.f.upem;
        const { u, res } = fontOn(page, r.key, s.f);
        // One run of glyphs in the order they stand (as a PDF is read, right
        // to left text included), each moved by what the shaping says: kerning,
        // marks set over their letter, raised or lowered where they sit.
        const [px, py] = o.toPdf(x, o.base);
        const ops = [L.pushGraphicsState(), L.setFillingRgbColor(o.color.red, o.color.green, o.color.blue), L.beginText(), L.setFontAndSize(res, o.size)];
        if (o.invisible) ops.push(L.setTextRenderingMode(L.TextRenderingMode.Invisible));
        if (sx !== 1) ops.push(L.setCharacterSqueeze(sx * 100));
        ops.push(L.setTextMatrix(cos, sin, -sin, cos, px, py));
        let tj = [];
        const flush = () => { if (tj.length) ops.push(L.PDFOperator.of('TJ', [arrayOf(doc.context, L, tj)])); tj = []; };
        const hexOf = (cid) => L.PDFHexString.of(cid.toString(16).padStart(4, '0'));
        // A glyph stands for the first character of its cluster; the rest
        // follow as invisible stand-ins with no width. (Text that holds a
        // combining sign, as a Hindi syllable does, is taken by PDF.js for an
        // accent with no width of its own, and the letter after it for the
        // start of a new word.)
        const hex = (g) => hexOf(cidOf(u, g.gid, g.text ? String.fromCodePoint(g.text.codePointAt(0)) : '', false));
        const rest = (g) => [...(g.text || '')].slice(1);
        // Marks set off their place (an Arabic letter's dots, accents) stand
        // for nothing of their own and are drawn afterwards, each where it
        // goes: a nudge inside the run reads to text tools as a space.
        const marks = [];
        let pen = 0;
        let owed = 0; // the advance of marks taken out, in thousandths of the size
        for (const g of s.glyphs) {
          const w = Math.round(s.f.font.glyphHAdvance(g.gid) * em);
          const adv = (g.adv || 0) * em;
          const xo = (g.x - pen) * em; // where it stands, from where the pen is
          if (!g.text && (xo || g.y)) { marks.push(g); owed += adv; pen += g.adv || 0; continue; }
          if (owed) { tj.push(-owed); owed = 0; }
          if (g.y) {
            flush();
            ops.push(L.PDFOperator.of('Ts', [L.PDFNumber.of(g.y * k)]));
            tj.push(-xo, hex(g), -(adv - w - xo));
            flush();
            ops.push(L.PDFOperator.of('Ts', [L.PDFNumber.of(0)]));
          } else tj.push(-xo, hex(g), -(adv - w - xo));
          const more = rest(g);
          if (more.length) {
            flush();
            ops.push(L.setTextRenderingMode(L.TextRenderingMode.Invisible));
            tj.push(...more.map((ch) => hexOf(cidOf(u, 0, ch, true))));
            flush();
            ops.push(L.setTextRenderingMode(o.invisible ? L.TextRenderingMode.Invisible : L.TextRenderingMode.Fill));
          }
          pen += g.adv || 0;
        }
        flush();
        for (const g of marks) {
          const [mx, my] = o.toPdf(x + g.x * k * sx, o.base - g.y * k);
          ops.push(L.setTextMatrix(cos, sin, -sin, cos, mx, my), L.PDFOperator.of('Tj', [hex(g)]));
        }
        ops.push(L.endText(), L.popGraphicsState());
        page.pushOperators(...ops);
        x += s.advance * k * sx;
      }
      return x - o.x;
    }

    async function finish() {
      for (const [key, u] of used) await embed(doc, L, key, u);
    }
    return { draw, finish };
  }

  /* ----- the font, cut down to the letters used ----- */

  // a TrueType font's tables: tag → { off, len }
  function tables(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = {};
    for (let i = 0, n = dv.getUint16(4); i < n; i++) {
      const o = 12 + i * 16;
      out[String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
    }
    return { dv, t: out };
  }

  // The glyphs a set of glyphs draws with: a composite glyph (é as e and ´) is
  // drawn from others, which go in too.
  function withParts(bytes, gids) {
    const { dv, t } = tables(bytes);
    const all = new Set(gids);
    if (!t.glyf || !t.loca || !t.head) return all;
    const long = dv.getInt16(t.head.off + 50) === 1;
    const loc = (g) => (long ? dv.getUint32(t.loca.off + g * 4) : dv.getUint16(t.loca.off + g * 2) * 2);
    const todo = [...all];
    while (todo.length) {
      const g = todo.pop();
      const start = loc(g);
      if (loc(g + 1) === start) continue; // empty
      let p = t.glyf.off + start;
      if (dv.getInt16(p) >= 0) continue; // a simple glyph
      p += 10;
      for (;;) {
        const flags = dv.getUint16(p);
        const part = dv.getUint16(p + 2);
        if (!all.has(part)) { all.add(part); todo.push(part); }
        p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
        if (!(flags & 0x20)) break;
      }
    }
    return all;
  }

  let subsetter = null;
  function hbSubset() {
    if (!subsetter) {
      subsetter = (async () => {
        const url = new URL('vendor/harfbuzz/harfbuzz-subset.wasm', document.baseURI).href;
        const res = await fetch(url);
        const { instance } = await WebAssembly.instantiate(await res.arrayBuffer());
        if (instance.exports._initialize) instance.exports._initialize();
        return instance.exports;
      })();
      subsetter.catch(() => { subsetter = null; });
    }
    return subsetter;
  }

  const tagNum = (s) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
  // Only these glyphs, renumbered in order (so the glyph map is known); or,
  // should the count not come out as expected, keeping their numbers.
  async function subset(bytes, keep) {
    const X = await hbSubset();
    const mem = () => new Uint8Array(X.memory.buffer);
    const run = (flags) => {
      const ptr = X.malloc(bytes.length);
      mem().set(bytes, ptr);
      const blob = X.hb_blob_create(ptr, bytes.length, 2 /* writable */, 0, 0);
      const face = X.hb_face_create(blob, 0);
      const input = X.hb_subset_input_create_or_fail();
      const gs = X.hb_subset_input_glyph_set(input);
      for (const g of keep) X.hb_set_add(gs, g);
      // tables a PDF has no use for: shaping is done
      const drop = X.hb_subset_input_set(input, 3 /* drop table tags */);
      for (const tg of ['GSUB', 'GPOS', 'GDEF', 'BASE', 'STAT', 'vhea', 'vmtx', 'VORG', 'gasp', 'morx', 'kern']) X.hb_set_add(drop, tagNum(tg));
      X.hb_subset_input_set_flags(input, flags);
      const out = X.hb_subset_or_fail(face, input);
      let result = null;
      if (out) {
        const ob = X.hb_face_reference_blob(out);
        const lenPtr = X.malloc(4);
        const dp = X.hb_blob_get_data(ob, lenPtr);
        const len = new DataView(X.memory.buffer).getUint32(lenPtr, true);
        result = mem().slice(dp, dp + len);
        X.free(lenPtr);
      }
      X.hb_subset_input_destroy(input);
      X.free(ptr);
      return result;
    };
    // no hinting, no layout closure (the text is shaped already), the notdef outline kept
    const sorted = [...keep].sort((a, b) => a - b);
    const compact = run(0x1 | 0x200 | 0x40);
    if (compact) {
      const { dv, t } = tables(compact);
      if (t.maxp && dv.getUint16(t.maxp.off + 4) === sorted.length) return { bytes: compact, map: new Map(sorted.map((g, i) => [g, i])) };
    }
    // keeping their numbers; or, failing that too, the whole font
    const kept = run(0x1 | 0x2 | 0x200 | 0x40) || bytes;
    return { bytes: kept, map: new Map(sorted.map((g) => [g, g])) };
  }

  const utf16Hex = (s) => Array.from(s, (c) => { const cp = c.codePointAt(0); return cp > 0xffff ? String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)) : c; })
    .join('').split('').map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');

  async function embed(doc, L, key, u) {
    const ctx = doc.context;
    const f = u.f;
    const gids = [...new Set(u.gidOf)];
    const { bytes, map } = await subset(f.bytes, withParts(f.bytes, [0, ...gids]));
    const em = 1000 / f.upem;
    const { dv, t } = tables(f.bytes);
    const head = t.head.off;
    const hhea = t.hhea.off;
    const bbox = [dv.getInt16(head + 36), dv.getInt16(head + 38), dv.getInt16(head + 40), dv.getInt16(head + 42)].map((v) => Math.round(v * em));
    const ascent = Math.round(dv.getInt16(hhea + 4) * em);
    const descent = Math.round(dv.getInt16(hhea + 6) * em);
    const file = ctx.register(ctx.flateStream(bytes, { Length1: bytes.length }));
    const descriptor = ctx.register(ctx.obj({
      Type: 'FontDescriptor', FontName: u.name, Flags: 4, FontBBox: bbox, ItalicAngle: 0,
      Ascent: ascent, Descent: descent, CapHeight: ascent, StemV: 80, FontFile2: file
    }));
    // widths, and the glyph in the cut-down font, by character id
    const n = u.gidOf.length;
    const W = [1, u.gidOf.slice(1).map((g, i) => (u.zero.has(i + 1) ? 0 : Math.round(f.font.glyphHAdvance(g) * em)))];
    const cidMap = new Uint8Array(n * 2);
    u.gidOf.forEach((g, cid) => { const ng = map.get(g) || 0; cidMap[cid * 2] = ng >> 8; cidMap[cid * 2 + 1] = ng & 255; });
    const cidToGid = ctx.register(ctx.flateStream(cidMap));
    const cid = ctx.register(ctx.obj({
      Type: 'Font', Subtype: 'CIDFontType2', BaseFont: u.name,
      CIDSystemInfo: { Registry: L.PDFString.of('Adobe'), Ordering: L.PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptor, W, DW: 1000, CIDToGIDMap: cidToGid
    }));
    // what each stands for, to search and copy; a glyph that is only part of
    // a letter (an Arabic letter's dots, a vowel sign drawn in two pieces)
    // stands for an invisible mark, which text tools pass over
    const entries = u.textOf.slice(1).map((txt, i) => '<' + (i + 1).toString(16).padStart(4, '0') + '> <' + utf16Hex(txt || '\u2060') + '>');
    let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
      '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    for (let i = 0; i < entries.length; i += 100) {
      const part = entries.slice(i, i + 100);
      cmap += part.length + ' beginbfchar\n' + part.join('\n') + '\nendbfchar\n';
    }
    cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
    const toUnicode = ctx.register(ctx.flateStream(new TextEncoder().encode(cmap)));
    ctx.assign(u.ref, ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: u.name, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: toUnicode }));
  }

  /* ----- on screen ----- */

  const faces = new Set(); // keys added to the page as fonts
  // what each is used for on screen (the page's own fonts show the rest)
  const JOIN = 'U+200C-200D, ';
  const RANGES = {
    NotoSans: 'U+0100-02FF, U+0370-03FF, U+0400-052F, U+1E00-1EFF', NotoSerif: 'U+0100-02FF, U+0370-03FF, U+0400-052F, U+1E00-1EFF',
    NotoSansMono: 'U+0100-02FF, U+0370-03FF, U+0400-052F, U+1E00-1EFF',
    NotoSansArabic: JOIN + 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF', NotoSansHebrew: 'U+0590-05FF, U+FB1D-FB4F',
    NotoSansDevanagari: JOIN + 'U+0900-097F, U+A8E0-A8FF', NotoSansBengali: JOIN + 'U+0980-09FF', NotoSansTamil: JOIN + 'U+0B80-0BFF',
    NotoSansTelugu: JOIN + 'U+0C00-0C7F', NotoSansGujarati: JOIN + 'U+0A80-0AFF', NotoSansGurmukhi: JOIN + 'U+0A00-0A7F', NotoSansThai: 'U+0E00-0E7F',
    han: 'U+2E80-9FFF, U+AC00-D7AF, U+F900-FAFF, U+FE30-FE4F, U+FF00-FFEF'
  };
  const cssName = (fam) => 'np-' + fam.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  // The Noto fonts the text needs, added to the page so it shows (and is
  // measured) as it will be saved.
  async function prepare(text, o) {
    const want = new Set();
    for (const ch of String(text || '')) {
      if (NEUTRAL.test(ch) || (!COMPLEX.test(ch) && ch.codePointAt(0) < 0x100)) continue;
      const fam = familyOf(ch, o);
      want.add(fam + '-' + styleOf(fam, o));
    }
    let added = false;
    for (const key of want) {
      if (faces.has(key)) continue;
      const [fam, style] = key.split('-');
      const face = new FontFace(cssName(fam), await fontBytes(key), {
        weight: /Bold/.test(style) ? '700' : '400', style: /Italic/.test(style) ? 'italic' : 'normal', unicodeRange: RANGES[fam] || RANGES.han
      });
      await face.load();
      document.fonts.add(face);
      faces.add(key);
      added = true;
    }
    return added;
  }

  // the Noto family names, Chinese characters' fonts in the document's order
  function css(lang) {
    const cjk = [han(lang || ''), 'NotoSansSC', 'NotoSansTC', 'NotoSansJP', 'NotoSansKR'].filter((v, i, a) => a.indexOf(v) === i);
    return ['NotoSans', 'NotoSansArabic', 'NotoSansHebrew', 'NotoSansDevanagari', 'NotoSansBengali', 'NotoSansTamil', 'NotoSansTelugu',
      'NotoSansGujarati', 'NotoSansGurmukhi', 'NotoSansThai'].concat(cjk).map((f) => '"' + cssName(f) + '"').join(', ');
  }

  window.NpShape = { needs, writer, prepare, css, families: () => Object.keys(FONTS) };
})();
