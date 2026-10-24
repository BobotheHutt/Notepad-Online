/* Notepad Online — finding and fetching the font a PDF was set in.

   NpFonts.fromName(baseFont)   the PDF names its font: find that family (or
                                its free metric twin, for Arial, Times, Calibri…)
   NpFonts.identify(samples)    a scan only has pictures of letters: draw the
                                same words in common document fonts and keep
                                the closest match
   NpFonts.load(ref)            fetch the font file (Fontsource, through
                                jsDelivr) and make it usable on screen; the same
                                bytes are embedded in the downloaded PDF

   Only font files are requested; nothing about the document leaves the page. */
(function () {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/@fontsource/';

  // Common document typefaces, with the weights Fontsource has for them.
  const W9 = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  const CATALOG = {
    arimo: ['Arimo', 'sans', [400, 500, 600, 700]], 'open-sans': ['Open Sans', 'sans', [300, 400, 500, 600, 700, 800]],
    roboto: ['Roboto', 'sans', W9], lato: ['Lato', 'sans', [100, 300, 400, 700, 900]],
    'source-sans-3': ['Source Sans 3', 'sans', W9.slice(1)], 'noto-sans': ['Noto Sans', 'sans', W9],
    montserrat: ['Montserrat', 'sans', W9], 'pt-sans': ['PT Sans', 'sans', [400, 700]], carlito: ['Carlito', 'sans', [400, 700]],
    inter: ['Inter', 'sans', W9], 'work-sans': ['Work Sans', 'sans', W9], 'fira-sans': ['Fira Sans', 'sans', W9],
    ubuntu: ['Ubuntu', 'sans', [300, 400, 500, 700]], raleway: ['Raleway', 'sans', W9], nunito: ['Nunito', 'sans', W9.slice(1)],
    poppins: ['Poppins', 'sans', W9], 'ibm-plex-sans': ['IBM Plex Sans', 'sans', W9.slice(0, 7)], 'libre-franklin': ['Libre Franklin', 'sans', W9],
    mulish: ['Mulish', 'sans', W9.slice(1)],
    tinos: ['Tinos', 'serif', [400, 700]], caladea: ['Caladea', 'serif', [400, 700]], 'noto-serif': ['Noto Serif', 'serif', W9],
    'pt-serif': ['PT Serif', 'serif', [400, 700]], merriweather: ['Merriweather', 'serif', W9.slice(2)], 'eb-garamond': ['EB Garamond', 'serif', [400, 500, 600, 700, 800]],
    'libre-baskerville': ['Libre Baskerville', 'serif', [400, 500, 600, 700]], gelasio: ['Gelasio', 'serif', [400, 500, 600, 700]],
    'source-serif-4': ['Source Serif 4', 'serif', W9.slice(1)], lora: ['Lora', 'serif', [400, 500, 600, 700]], 'roboto-slab': ['Roboto Slab', 'serif', W9],
    cousine: ['Cousine', 'mono', [400, 700]]
  };

  // Fonts that cannot be downloaded, and the free fonts drawn to the same
  // widths (or the closest common substitute).
  const TWINS = [
    [/^(arial|arialmt|helvetica|helveticaneue|liberationsans|nimbussans)/, 'arimo'],
    [/^(timesnewroman|times|liberationserif|nimbusroman)/, 'tinos'],
    [/^(couriernew|courier|liberationmono|nimbusmono)/, 'cousine'],
    [/^calibri/, 'carlito'], [/^cambria/, 'caladea'], [/^georgia/, 'gelasio'],
    [/^(garamond|adobegaramond|garamondpremier)/, 'eb-garamond'],
    [/^(segoeui|verdana|tahoma|dejavusans)/, 'noto-sans'],
    [/^(bookantiqua|palatino)/, 'pt-serif'], [/^(franklingothic)/, 'libre-franklin']
  ];

  const WEIGHT_WORDS = [[/thin|hairline/, 100], [/extralight|ultralight/, 200], [/light/, 300], [/medium/, 500],
    [/semibold|demibold|demi/, 600], [/extrabold|ultrabold/, 800], [/black|heavy/, 900], [/bold/, 700]];

  const meta = new Map();   // id → metadata (or null when Fontsource has no such font)
  const files = new Map();  // url → Promise<ArrayBuffer>
  const faces = new Map();  // css family → Promise<FontFace>

  function cssFamily(ref) {
    return 'np-' + ref.id + '-' + ref.weight + (ref.style === 'italic' ? 'i' : '');
  }

  function fileUrl(ref, subset, ext) {
    return CDN + ref.id + '/files/' + ref.id + '-' + (subset || 'latin') + '-' + ref.weight + '-' + (ref.style || 'normal') + '.' + (ext || 'woff2');
  }

  async function cachedFetch(url) {
    if (!files.has(url)) {
      files.set(url, (async () => {
        let cache = null;
        try { cache = typeof caches !== 'undefined' ? await caches.open('np-fonts-v1') : null; } catch (e) { cache = null; }
        if (cache) {
          const hit = await cache.match(url);
          if (hit) return hit.arrayBuffer();
        }
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error('font not found');
        if (cache) { try { await cache.put(url, res.clone()); } catch (e) { /* storage full: fine */ } }
        return res.arrayBuffer();
      })());
      files.get(url).catch(() => files.delete(url));
    }
    return files.get(url);
  }

  async function getMeta(id) {
    if (CATALOG[id]) return { id, family: CATALOG[id][0], category: CATALOG[id][1], weights: CATALOG[id][2], styles: ['normal', 'italic'] };
    if (meta.has(id)) return meta.get(id);
    let m = null;
    try {
      const res = await fetch(CDN + id + '/metadata.json', { mode: 'cors' });
      if (res.ok) {
        const j = await res.json();
        m = { id, family: j.family, category: /serif/.test(j.category) && !/sans/.test(j.category) ? 'serif' : j.category === 'monospace' ? 'mono' : 'sans', weights: j.weights || [400], styles: j.styles || ['normal'] };
      }
    } catch (e) { m = null; }
    meta.set(id, m);
    return m;
  }

  const nearest = (list, w) => list.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a), list[0]);

  /** Load a font for screen use. ref = { id, weight, style }. Resolves to the CSS family name. */
  async function load(ref) {
    const fam = cssFamily(ref);
    if (!faces.has(fam)) {
      faces.set(fam, (async () => {
        const buf = await cachedFetch(fileUrl(ref));
        const face = new FontFace(fam, buf, { weight: String(ref.weight), style: ref.style || 'normal' });
        await face.load();
        document.fonts.add(face);
        return face;
      })());
      faces.get(fam).catch(() => faces.delete(fam));
    }
    await faces.get(fam);
    return fam;
  }

  /** Font file bytes for embedding in a PDF. WOFF, not WOFF2: WOFF2 stores
   *  glyph outlines transformed, and the PDF subsetter writes them out blank. */
  function bytes(ref, subset) {
    return cachedFetch(fileUrl(ref, subset, 'woff'));
  }

  function label(ref) {
    const m = CATALOG[ref.id];
    const name = (m && m[0]) || ref.family || ref.id;
    const wname = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: '', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' }[ref.weight] || '';
    return (name + ' ' + wname + (ref.style === 'italic' ? ' Italic' : '')).replace(/\s+/g, ' ').trim();
  }

  /* ---------------------------------------------------------- by name */

  function parseName(baseFont) {
    let n = String(baseFont || '').replace(/^[A-Z]{6}\+/, '');
    const parts = n.split(/[-,]/);
    const fam = parts[0];
    const rest = parts.slice(1).join('').toLowerCase();
    const flat = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    let weight = 400;
    for (const [re, w] of WEIGHT_WORDS) if (re.test(rest || flat.slice(fam.length))) { weight = w; break; }
    const italic = /italic|oblique/.test(rest || flat);
    // "OpenSansSemibold" with no hyphen: peel known weight words off the end
    let base = fam;
    const tail = /(Thin|ExtraLight|Light|Regular|Book|Medium|SemiBold|Semibold|DemiBold|ExtraBold|Bold|Black|Heavy|Italic|Oblique|MT|PS)+$/;
    if (!rest) {
      const m = fam.match(tail);
      if (m) {
        const t = m[0].toLowerCase();
        for (const [re, w] of WEIGHT_WORDS) if (re.test(t)) { weight = w; break; }
        base = fam.slice(0, fam.length - m[0].length);
      }
    }
    base = base.replace(/(MT|PS)$/, '');
    const kebab = base.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([A-Za-z])(\d)/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase();
    return { flat: base.toLowerCase().replace(/[^a-z0-9]/g, ''), kebab, weight, italic };
  }

  /** → { id, weight, style, twin } or null */
  async function fromName(baseFont, hints) {
    const p = parseName(baseFont);
    if (!p.flat) return null;
    if (hints && hints.bold && p.weight < 600) p.weight = 700;
    if (hints && hints.italic) p.italic = true;
    let id = null;
    let twin = false;
    for (const [re, t] of TWINS) if (re.test(p.flat)) { id = t; twin = true; break; }
    if (!id) {
      for (const cand of [p.kebab, p.flat]) {
        if (await getMeta(cand)) { id = cand; break; }
      }
    }
    if (!id) return null;
    const m = await getMeta(id);
    if (!m) return null;
    return { id, weight: nearest(m.weights, p.weight), style: p.italic && m.styles.includes('italic') ? 'italic' : 'normal', twin };
  }

  /* ---------------------------------------------------------- by look */

  const BOX_H = 40;

  // Ink of a canvas region, cut to its tight box and scaled to BOX_H rows,
  // as 0/1 pixels. Returns null when there is no ink.
  function normalize(src, sx, sy, sw, sh, threshold) {
    const g = src.getContext('2d', { willReadFrequently: true });
    const d = g.getImageData(sx, sy, sw, sh).data;
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo < 50) return null;
    const thr = threshold || (lo + hi) / 2;
    let x0 = sw;
    let y0 = sh;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const iw = x1 - x0 + 1;
    const ih = y1 - y0 + 1;
    const w = Math.max(4, Math.round((iw / ih) * BOX_H));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = BOX_H;
    const cg = c.getContext('2d', { willReadFrequently: true });
    cg.fillStyle = '#fff';
    cg.fillRect(0, 0, w, BOX_H);
    // the same slight softening for the scan and for the candidate, so a
    // scan's blurred edges do not make every heavier font look closer
    if ('filter' in cg) cg.filter = 'blur(0.9px)';
    cg.drawImage(src, sx + x0, sy + y0, iw, ih, 0, 0, w, BOX_H);
    const out = cg.getImageData(0, 0, w, BOX_H).data;
    const ink = new Float32Array(w * BOX_H);
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < ink.length; i++) ink[i] = Math.min(1, Math.max(0, (hi - (out[i * 4] * 0.299 + out[i * 4 + 1] * 0.587 + out[i * 4 + 2] * 0.114)) / span));
    return { ink, w, aspect: iw / ih };
  }

  const scratch = document.createElement('canvas');

  function renderWord(text, family, weight, style) {
    const size = 64;
    scratch.width = Math.ceil(text.length * size * 0.9 + size);
    scratch.height = Math.ceil(size * 1.6);
    const g = scratch.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, scratch.width, scratch.height);
    g.fillStyle = '#000';
    g.font = (style === 'italic' ? 'italic ' : '') + weight + ' ' + size + 'px "' + family + '"';
    g.textBaseline = 'alphabetic';
    g.fillText(text, size * 0.3, size * 1.15);
    return normalize(scratch, 0, 0, scratch.width, scratch.height, 128);
  }

  // Correlation of the two ink images (b stretched to a's width), less a
  // penalty when one word is wider for its height than the other.
  function similarity(a, b) {
    const n = a.w * BOX_H;
    let sa = 0;
    let sb = 0;
    const bv = new Float32Array(n);
    for (let y = 0; y < BOX_H; y++) for (let x = 0; x < a.w; x++) {
      const v = b.ink[y * b.w + Math.min(b.w - 1, Math.floor((x * b.w) / a.w))];
      bv[y * a.w + x] = v;
      sb += v;
      sa += a.ink[y * a.w + x];
    }
    const ma = sa / n;
    const mb = sb / n;
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < n; i++) {
      const da = a.ink[i] - ma;
      const db = bv[i] - mb;
      cov += da * db;
      va += da * da;
      vb += db * db;
    }
    const r = va && vb ? cov / Math.sqrt(va * vb) : 0;
    return r - Math.abs(Math.log(b.aspect / a.aspect)) * 0.6;
  }

  async function pool(items, n, fn) {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }

  /**
   * samples: [{ text, canvas, x, y, w, h }] — words cut from a high-resolution
   * render of the page. hints: { bold }. → { id, weight, style, score } or null.
   */
  const prep = (samples) => samples.map((s) => Object.assign({ text: s.text }, normalize(s.canvas, s.x, s.y, s.w, s.h) || {})).filter((s) => s.ink);

  async function scoreOf(norm, ref) {
    let fam;
    try { fam = await load(ref); } catch (e) { return -9; }
    let total = 0;
    for (const s of norm) {
      const r = renderWord(s.text, fam, ref.weight, ref.style);
      total += r ? similarity(s, r) : -1;
    }
    return total / norm.length;
  }

  // How well one font matches the samples (1 is a perfect match), or null.
  async function score(samples, ref) {
    const norm = prep(samples);
    return norm.length ? scoreOf(norm, ref) : null;
  }

  async function identify(samples, hints) {
    const norm = prep(samples);
    if (!norm.length) return null;
    const score = (ref) => scoreOf(norm, ref);
    const w0 = hints && hints.bold ? 700 : 400;
    // first pass: every candidate at the likely weight
    const ids = Object.keys(CATALOG);
    const first = await pool(ids, 6, async (id) => {
      const ref = { id, weight: nearest(CATALOG[id][2], w0), style: 'normal' };
      return { ref, s: await score(ref) };
    });
    first.sort((a, b) => b.s - a.s);
    // second pass: the best few at every weight they come in
    const top = first.slice(0, 3);
    const tries = [];
    // within the weight the strokes say (a scan thickens letters, so left
    // free a regular line drifts heavier)
    const [lo, hi] = hints && hints.bold === true ? [600, 800] : hints && hints.bold === false ? [300, 500] : [300, 800];
    for (const t of top) for (const w of CATALOG[t.ref.id][2]) if (w >= lo && w <= hi) tries.push({ id: t.ref.id, weight: w, style: 'normal' });
    const second = await pool(tries, 6, async (ref) => ({ ref, s: await score(ref) }));
    second.sort((a, b) => b.s - a.s);
    const best = second[0] || first[0];
    if (!best || best.s < 0.3) return null;
    return Object.assign({}, best.ref, { score: Math.round(best.s * 1000) / 1000, ranking: second.slice(0, 5).map((r) => r.ref.id + ' ' + r.ref.weight + ' ' + r.s.toFixed(3)) });
  }

  window.NpFonts = { CATALOG, load, bytes, label, cssFamily, fromName, identify, score, parseName };
})();
