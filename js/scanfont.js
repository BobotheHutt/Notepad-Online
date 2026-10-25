/* Noteshack — fonts made from a scan's own letters.

   Like Acrobat's ClearScan: every copy of a letter cut from the scan is
   laid over the others and averaged, which takes away the scan's noise;
   the average is traced into a smooth outline; and the outlines go into a
   copy of the matched font, in place of its own letters. Letters the scan
   does not show keep the matched font's shapes.

   NpScanFont.build(baseFontBytes, samples, name) → ArrayBuffer (an OpenType
     font, renamed to name: a changed font does not keep the original's name)
     samples: { char: [{ ink: Float32Array (0 paper … 1 ink), w, h,
                         base: rows from the top to the baseline, em: pixels per em }] }

   Needs opentype.js (vendor/opentype). */
(function () {
  'use strict';

  const UP = 4;          // the averaged letter is traced at this many times its scanned size
  const MIN_SAMPLES = 2; // a letter seen once may be a misread: the font's own shape is kept

  /* ----- averaging ----- */

  function corr(a, b) {
    let sa = 0, sb = 0, n = a.length;
    for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
    const ma = sa / n, mb = sb / n;
    let c = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; c += x * y; va += x * x; vb += y * y; }
    return va && vb ? c / Math.sqrt(va * vb) : 0;
  }

  // Every sample scaled to one em and placed by its left edge and baseline
  // on a common grid, then averaged; samples unlike the rest (a misread, a
  // letter touching a line) are dropped first.
  function average(list) {
    const em = list.map((s) => s.em).sort((a, b) => a - b)[list.length >> 1];
    const scaled = list.map((s) => {
      const k = em / s.em;
      return { s, k, w: s.w * k, h: s.h * k, base: s.base * k };
    });
    const asc = Math.max(...scaled.map((q) => q.base));
    const desc = Math.max(...scaled.map((q) => q.h - q.base));
    const W = Math.ceil(Math.max(...scaled.map((q) => q.w))) + 2;
    const H = Math.ceil(asc + desc) + 2;
    const grid = (q) => {
      const g = new Float32Array(W * H);
      const oy = asc - q.base + 1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // bilinear sample of the source at this grid point
          const sx = (x - 1) / q.k;
          const sy = (y - oy) / q.k;
          if (sx < -0.5 || sy < -0.5 || sx > q.s.w - 0.5 || sy > q.s.h - 0.5) continue;
          const x0 = Math.max(0, Math.min(q.s.w - 1, Math.floor(sx)));
          const y0 = Math.max(0, Math.min(q.s.h - 1, Math.floor(sy)));
          const x1 = Math.min(q.s.w - 1, x0 + 1);
          const y1 = Math.min(q.s.h - 1, y0 + 1);
          const fx = Math.max(0, Math.min(1, sx - x0));
          const fy = Math.max(0, Math.min(1, sy - y0));
          const v = q.s.ink;
          const sw = q.s.w;
          g[y * W + x] = v[y0 * sw + x0] * (1 - fx) * (1 - fy) + v[y0 * sw + x1] * fx * (1 - fy) + v[y1 * sw + x0] * (1 - fx) * fy + v[y1 * sw + x1] * fx * fy;
        }
      }
      return g;
    };
    let grids = scaled.map(grid);
    const mean = (gs) => { const m = new Float32Array(W * H); for (const g of gs) for (let i = 0; i < m.length; i++) m[i] += g[i] / gs.length; return m; };
    let avg = mean(grids);
    if (grids.length >= 3) {
      const kept = grids.filter((g) => corr(g, avg) >= 0.75);
      if (kept.length >= MIN_SAMPLES) { grids = kept; avg = mean(grids); }
    }
    // the samples must agree with one another, or the letter is left alone
    const agree = grids.reduce((t, g) => t + corr(g, avg), 0) / grids.length;
    return { avg, W, H, asc: asc + 1, em, n: grids.length, agree };
  }

  // The averaged letter at UP times the size, as ink or paper. The cut-off
  // between them keeps the letter's amount of ink: averaging softens the
  // edges, and a fixed halfway cut would thin every stroke.
  function upsample(a) {
    const W = a.W * UP;
    const H = a.H * UP;
    let mass = 0;
    for (const v of a.avg) mass += v;
    const sorted = Array.from(a.avg).sort((p, q) => q - p);
    const cut = Math.max(0.25, Math.min(0.6, sorted[Math.min(sorted.length - 1, Math.round(mass))] || 0.5));
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = (x + 0.5) / UP - 0.5;
        const sy = (y + 0.5) / UP - 0.5;
        const x0 = Math.max(0, Math.min(a.W - 1, Math.floor(sx)));
        const y0 = Math.max(0, Math.min(a.H - 1, Math.floor(sy)));
        const x1 = Math.min(a.W - 1, x0 + 1);
        const y1 = Math.min(a.H - 1, y0 + 1);
        const fx = Math.max(0, Math.min(1, sx - x0));
        const fy = Math.max(0, Math.min(1, sy - y0));
        const v = a.avg[y0 * a.W + x0] * (1 - fx) * (1 - fy) + a.avg[y0 * a.W + x1] * fx * (1 - fy) + a.avg[y1 * a.W + x0] * (1 - fx) * fy + a.avg[y1 * a.W + x1] * fx * fy;
        out[y * W + x] = v >= cut ? 1 : 0;
      }
    }
    return { px: out, W, H };
  }

  /* ----- tracing ----- */

  // The outlines of the ink, following the pixel edges with the ink always
  // on the same side, so outer edges and holes run opposite ways round.
  function trace(b) {
    const { px, W, H } = b;
    const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && px[y * W + x] === 1;
    const next = new Map(); // "x,y" of an edge's start → list of its ends
    const add = (x0, y0, x1, y1) => {
      const k = x0 + ',' + y0;
      if (!next.has(k)) next.set(k, []);
      next.get(k).push([x1, y1]);
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!on(x, y)) continue;
        if (!on(x, y - 1)) add(x, y, x + 1, y);
        if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
        if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
        if (!on(x - 1, y)) add(x, y + 1, x, y);
      }
    }
    const loops = [];
    for (const [k0, list] of next) {
      while (list.length) {
        const [sx, sy] = k0.split(',').map(Number);
        const pts = [[sx, sy]];
        let cur = list.pop();
        let prev = [sx, sy];
        let guard = 0;
        while (guard++ < 1e6) {
          const [cx, cy] = cur;
          if (cx === sx && cy === sy) break;
          pts.push([cx, cy]);
          const outs = next.get(cx + ',' + cy);
          if (!outs || !outs.length) break;
          // where two corners touch, turn the same way each time
          let pick = 0;
          if (outs.length > 1) {
            const dx = cx - prev[0];
            const dy = cy - prev[1];
            pick = outs.findIndex(([nx, ny]) => (nx - cx) === -dy && (ny - cy) === dx);
            if (pick < 0) pick = 0;
          }
          prev = cur;
          cur = outs.splice(pick, 1)[0];
        }
        if (pts.length >= 4) loops.push(pts);
      }
    }
    return loops;
  }

  // Fewer points: corners only where the outline really turns.
  function simplify(loop, eps) {
    const n = loop.length;
    if (n < 4) return loop;
    // split the closed loop at its two farthest-apart points
    let a = 0;
    let b = 0;
    let best = -1;
    for (let i = 0; i < n; i += Math.max(1, n >> 6)) {
      for (let j = 0; j < n; j++) {
        const d = (loop[i][0] - loop[j][0]) ** 2 + (loop[i][1] - loop[j][1]) ** 2;
        if (d > best) { best = d; a = i; b = j; }
      }
    }
    if (a > b) [a, b] = [b, a];
    const rdp = (pts) => {
      if (pts.length < 3) return pts;
      const [x0, y0] = pts[0];
      const [x1, y1] = pts[pts.length - 1];
      const L = Math.hypot(x1 - x0, y1 - y0) || 1;
      let far = 0;
      let at = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const d = Math.abs((pts[i][0] - x0) * (y1 - y0) - (pts[i][1] - y0) * (x1 - x0)) / L;
        if (d > far) { far = d; at = i; }
      }
      if (far <= eps) return [pts[0], pts[pts.length - 1]];
      const l = rdp(pts.slice(0, at + 1));
      const r = rdp(pts.slice(at));
      return l.slice(0, -1).concat(r);
    };
    const one = rdp(loop.slice(a, b + 1));
    const two = rdp(loop.slice(b).concat(loop.slice(0, a + 1)));
    return one.slice(0, -1).concat(two.slice(0, -1));
  }

  // The polygon as a smooth outline: quadratic curves through the middles of
  // its sides, with sharp corners kept as corners.
  function toPath(poly, tf, path) {
    const n = poly.length;
    if (n < 3) return;
    const corner = poly.map((p, i) => {
      const a = poly[(i - 1 + n) % n];
      const c = poly[(i + 1) % n];
      const u = [p[0] - a[0], p[1] - a[1]];
      const v = [c[0] - p[0], c[1] - p[1]];
      const cos = (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])) || 1);
      return cos < Math.cos((55 * Math.PI) / 180);
    });
    const mid = (i) => { const p = poly[i % n]; const q = poly[(i + 1) % n]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; };
    const T = (p) => tf(p[0], p[1]);
    let start = corner.indexOf(true);
    if (start < 0) {
      const m = T(mid(n - 1));
      path.moveTo(m[0], m[1]);
      for (let i = 0; i < n; i++) { const c = T(poly[i]); const e = T(mid(i)); path.quadraticCurveTo(c[0], c[1], e[0], e[1]); }
      path.close();
      return;
    }
    const s = T(poly[start]);
    path.moveTo(s[0], s[1]);
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      const p = T(poly[i]);
      if (corner[i]) path.lineTo(p[0], p[1]);
      else { const e = T(mid(i)); path.quadraticCurveTo(p[0], p[1], e[0], e[1]); }
    }
    path.close();
  }

  /* ----- the font ----- */

  // A changed font may not go by its original name (the Open Font License
  // reserves some, like "Source"): it takes a name of its own. The
  // copyright and license notices stay, as the license requires.
  function rename(font, name) {
    const ps = name.replace(/[^A-Za-z0-9]/g, '');
    const sub = (font.names.fontSubfamily && font.names.fontSubfamily.en) || 'Regular';
    for (const k of Object.keys(font.names)) {
      if (!['copyright', 'license', 'licenseURL', 'fontSubfamily'].includes(k)) delete font.names[k];
    }
    font.names.fontFamily = { en: name };
    font.names.fullName = { en: name + ' ' + sub };
    font.names.postScriptName = { en: ps + '-' + sub.replace(/[^A-Za-z0-9]/g, '') };
    font.names.uniqueID = { en: ps + '-' + sub.replace(/[^A-Za-z0-9]/g, '') + ';Noteshack' };
    font.names.version = { en: 'Version 1.0' };
    font.names.description = { en: 'Made by Noteshack from letters in a scanned page, on a modified copy of a font under the license below.' };
  }

  function build(baseBytes, samples, name) {
    if (typeof opentype === 'undefined') throw new Error('opentype.js is not loaded');
    const font = opentype.parse(baseBytes);
    const U = font.unitsPerEm;
    let replaced = 0;
    for (const [ch, list] of Object.entries(samples)) {
      if (!list || list.length < MIN_SAMPLES) continue;
      const glyph = font.charToGlyph(ch);
      if (!glyph || !glyph.index) continue;
      const a = average(list);
      if (a.n < MIN_SAMPLES || a.agree < 0.7) continue;
      const b = upsample(a);
      const loops = trace(b).map((l) => simplify(l, UP * 0.45)).filter((l) => l.length >= 3);
      if (!loops.length) continue;
      // pixels → font units: the grid's left ink edge at the font's own left
      // side bearing, its baseline row at 0
      const bb = glyph.getBoundingBox();
      const lsb = isFinite(bb.x1) ? bb.x1 : 0;
      const rsb = isFinite(bb.x2) ? glyph.advanceWidth - bb.x2 : 0;
      let inkX0 = Infinity;
      let inkX1 = -Infinity;
      for (const l of loops) for (const [x] of l) { if (x < inkX0) inkX0 = x; if (x > inkX1) inkX1 = x; }
      const k = U / (a.em * UP);
      // the scanned letter must be about the shape of the font's (a consistent
      // misread is not, nor two letters joined, like an fi ligature taken as f)
      const sh = isFinite(bb.y2) ? bb.y2 - bb.y1 : 0;
      const sw = isFinite(bb.x2) ? bb.x2 - bb.x1 : 0;
      let inkY0 = Infinity;
      let inkY1 = -Infinity;
      for (const l of loops) for (const [, y] of l) { if (y < inkY0) inkY0 = y; if (y > inkY1) inkY1 = y; }
      const nh = (inkY1 - inkY0) * k;
      const nw = (inkX1 - inkX0) * k;
      if (sh > 0 && sw > 0 && (nh / sh < 0.75 || nh / sh > 1.3 || nw / sw < 0.75 || nw / sw > 1.3)) continue;
      const tf = (x, y) => [lsb + (x - inkX0) * k, (a.asc * UP - y) * k];
      const path = new opentype.Path();
      for (const l of loops) toPath(l, tf, path);
      glyph.path = path;
      glyph.advanceWidth = Math.round(lsb + nw + rsb);
      glyph.leftSideBearing = Math.round(lsb);
      replaced++;
    }
    if (!replaced) return null;
    // ligatures and other substitutions are dropped: the writer cannot write
    // every kind, and the scanned letters are drawn one by one anyway
    delete font.tables.gsub;
    // every glyph named, as the font writer expects
    for (let i = 0; i < font.glyphs.length; i++) { const g = font.glyphs.get(i); if (!g.name) g.name = i ? 'g' + i : '.notdef'; }
    rename(font, name || 'Noteshack Scan');
    return { bytes: font.toArrayBuffer(), replaced };
  }

  window.NpScanFont = { build };
})();
