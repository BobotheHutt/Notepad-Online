/* Noteshack — the app's own language (menus, buttons, messages).

   Separate from a document's language (js/lang.js). Chosen in View → App
   language, or the browser's language when it is one of ours. The phrases
   are kept in English in the code and looked up in locales/<code>.js, which
   is loaded before the app starts (written into the page here, so it is
   there before any other script runs).

   NpI18n.t('Saved in {place}', { place })    a phrase, in the app's language
   NpI18n.n(count, '{n} page', '{n} pages')   with the plural the language uses
   NpI18n.dom(root)                           the page's own text and labels
   NpI18n.lang / locale / dir                 the language, for Intl, and its direction

   Test languages, from the address only (?lang=…): en-XA (every phrase
   accented and longer, to find text left untranslated or cut off) and ar-XB
   (the same, right to left, to check the interface mirrors). */
(function () {
  'use strict';

  const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it'];
  const PSEUDO = { 'en-XA': 'ltr', 'ar-XB': 'rtl' };
  const KEY = 'np.uilang';

  function saved() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function fromBrowser() {
    for (const l of navigator.languages || [navigator.language || 'en']) {
      const b = String(l).split('-')[0].toLowerCase();
      if (LANGS.includes(b)) return b;
    }
    return 'en';
  }
  let asked = null;
  try { asked = new URLSearchParams(location.search).get('lang'); } catch (e) { /* none */ }
  const setting = saved();
  let lang = asked || setting;
  if (!LANGS.includes(lang) && !PSEUDO[lang]) lang = fromBrowser();
  const pseudo = PSEUDO[lang] || null;
  const locale = pseudo ? 'en' : lang;
  const dir = pseudo === 'rtl' ? 'rtl' : 'ltr';

  let cat = null;
  const missing = new Set();
  if (!pseudo && lang !== 'en') document.write('<script src="locales/' + lang + '.js?' + window.NP_V + '"><\/script>');
  document.documentElement.lang = lang;
  document.documentElement.dir = dir;

  const ACCENT = { a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ğ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ľ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ʠ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
    A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ď', E: 'É', F: 'Ƒ', G: 'Ğ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ľ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž' };
  // accented, a third longer (as German or French often run), and marked at
  // both ends so a cut-off end shows
  function pseudoize(s) {
    const body = s.replace(/[A-Za-z]/g, (c) => ACCENT[c]);
    const pad = '~'.repeat(Math.ceil(s.length * 0.3));
    const out = '[' + body + pad + ']';
    return pseudo === 'rtl' ? '‮' + out + '‬' : out;
  }

  const num = (v) => (typeof v === 'number' ? v.toLocaleString(locale) : String(v));
  function fill(s, vars) {
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? num(vars[k]) : m)) : s;
  }

  function t(s, vars) {
    let out = s;
    if (cat) {
      const v = cat[s];
      if (typeof v === 'string') out = v; else missing.add(s);
    }
    out = fill(out, vars);
    return pseudo ? pseudoize(out) : out;
  }

  let rules = null;
  // n(count, one, other): the English forms; a language's own (one, few,
  // many, other…) are kept under the English plural
  function n(count, one, other, vars) {
    const v = Object.assign({ n: count }, vars);
    let out = count === 1 ? one : other;
    if (cat) {
      const forms = cat[other];
      if (forms && typeof forms === 'object') {
        rules = rules || new Intl.PluralRules(locale);
        out = forms[rules.select(count)] || forms.other;
      } else missing.add(other);
    }
    out = fill(out, v);
    return pseudo ? pseudoize(out) : out;
  }

  // the key names on shortcuts (Ctrl → Strg in German)
  const keys = (s) => s.replace(/\b(Ctrl|Shift|Alt|Enter|Esc|Tab|Space)\b/g, (k) => (cat && typeof cat['key:' + k] === 'string' ? cat['key:' + k] : k));

  const ATTRS = ['title', 'aria-label', 'placeholder', 'data-placeholder', 'alt'];
  const SKIP = 'script, style, noscript, [translate="no"], #editor, #pdf-pages, .doc-list';
  const LABELS_ONLY = '#editor, #pdf-pages';

  // The page's own text, translated where it stands (once, at start).
  function dom(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.nodeType === 1 && node.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    const texts = [];
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.nodeType === 3) { if (/\p{L}/u.test(node.nodeValue)) texts.push(node); continue; }
      if (node.tagName === 'KBD') { node.textContent = keys(node.textContent); continue; }
      for (const a of ATTRS) {
        const v = node.getAttribute(a);
        if (v && /\p{L}/u.test(v)) node.setAttribute(a, t(v.replace(/\s+/g, ' ').trim()));
      }
    }
    // the document's own areas: their labels only, not what is in them
    for (const node of root.querySelectorAll(LABELS_ONLY)) {
      for (const a of ATTRS) { const v = node.getAttribute(a); if (v && /\p{L}/u.test(v)) node.setAttribute(a, t(v.replace(/\s+/g, ' ').trim())); }
    }
    for (const node of texts) {
      if (node.parentElement && node.parentElement.closest('kbd')) continue;
      const v = node.nodeValue;
      const lead = v.match(/^\s*/)[0];
      const trail = v.match(/\s*$/)[0];
      node.nodeValue = lead + t(v.replace(/\s+/g, ' ').trim()) + trail;
    }
  }

  // every phrase the page itself holds (for the tests' missing-phrase check)
  function domPhrases(root) {
    const out = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.nodeType === 1 && node.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.nodeType === 3) {
        if (/\p{L}/u.test(node.nodeValue) && !(node.parentElement && node.parentElement.closest('kbd'))) out.add(node.nodeValue.replace(/\s+/g, ' ').trim());
        continue;
      }
      for (const a of ATTRS) { const v = node.getAttribute(a); if (v && /\p{L}/u.test(v)) out.add(v.replace(/\s+/g, ' ').trim()); }
    }
    for (const node of root.querySelectorAll(LABELS_ONLY)) {
      for (const a of ATTRS) { const v = node.getAttribute(a); if (v && /\p{L}/u.test(v)) out.add(v.replace(/\s+/g, ' ').trim()); }
    }
    return [...out];
  }

  function setLang(code) {
    try { if (code === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, code); } catch (e) { /* this visit only */ }
  }

  window.NpI18n = {
    lang, locale, dir, setting,
    languages: LANGS,
    t, n, dom, domPhrases, keys, setLang, missing,
    // the browser's language, when it is one of ours (for "Automatic")
    browserLang: fromBrowser,
    add(c) { cat = c; },
    get catalog() { return cat; }
  };
})();
