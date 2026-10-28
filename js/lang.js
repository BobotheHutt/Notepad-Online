/* Noteshack — languages.

   A document has a language of its own (separate from the language the app
   is shown in): it decides spell checking, which way text runs, and which
   language its scans are read in. It is found automatically from the text,
   on this computer, until someone sets it by hand.

   NpLang.list            the languages offered, { code, iso3, rtl }
   NpLang.name(code)      its name, in the browser's language ("Spanish")
   NpLang.native(code)    its name in itself ("Español")
   NpLang.isRtl(code)     written right to left
   NpLang.detect(text)    the language a text is in, or null if unsure;
                          franc (vendor/franc), loaded the first time */
(function () {
  'use strict';
  const _ = NpI18n.t; // the app's own language (js/i18n.js)

  // code (as HTML and Word take it), the ISO 639-3 code franc answers with,
  // and the direction of writing
  const LIST = [
    ['en', 'eng'], ['es', 'spa'], ['fr', 'fra'], ['de', 'deu'], ['pt', 'por'], ['it', 'ita'],
    ['nl', 'nld'], ['pl', 'pol'], ['sv', 'swe'], ['da', 'dan'], ['nb', 'nob'], ['fi', 'fin'],
    ['cs', 'ces'], ['sk', 'slk'], ['hu', 'hun'], ['ro', 'ron'], ['hr', 'hrv'], ['sl', 'slv'],
    ['et', 'est'], ['lv', 'lav'], ['lt', 'lit'], ['el', 'ell'], ['ru', 'rus'], ['uk', 'ukr'],
    ['bg', 'bul'], ['sr', 'srp'], ['tr', 'tur'], ['ar', 'arb', true], ['he', 'heb', true],
    ['fa', 'pes', true], ['ur', 'urd', true], ['hi', 'hin'], ['bn', 'ben'], ['ta', 'tam'],
    ['te', 'tel'], ['mr', 'mar'], ['gu', 'guj'], ['pa', 'pan'], ['zh-Hans', 'cmn'], ['zh-Hant', null],
    ['ja', 'jpn'], ['ko', 'kor'], ['th', 'tha'], ['vi', 'vie'], ['id', 'ind'], ['ms', 'zlm'],
    ['tl', 'tgl'], ['sw', 'swh'], ['ca', 'cat'], ['eu', null], ['gl', 'glg'], ['ga', null],
    ['cy', null], ['is', null], ['af', 'afr']
  ].map(([code, iso3, rtl]) => ({ code, iso3, rtl: !!rtl }));
  const BY_CODE = new Map(LIST.map((l) => [l.code, l]));
  const BY_ISO3 = new Map(LIST.filter((l) => l.iso3).map((l) => [l.iso3, l.code]));

  let ui = null;
  const names = (locale) => { try { return new Intl.DisplayNames([locale], { type: 'language' }); } catch (e) { return null; } };
  // in the app's language; capitalized, as it stands alone in a list or
  // label ("Inglés"), or as it comes inside a sentence (inline)
  function name(code, inline) {
    ui = ui || names(NpI18n.locale) || names('en');
    let n = code;
    try { n = (ui && ui.of(code)) || code; } catch (e) { /* the code itself */ }
    return inline ? n : n.charAt(0).toLocaleUpperCase(NpI18n.locale) + n.slice(1);
  }
  function native(code) {
    const n = names(code);
    try { return (n && n.of(code)) || name(code); } catch (e) { return name(code); }
  }

  // The language of the browser, if it is one of ours: the starting point
  // for a document with too little text to tell.
  function preferred() {
    for (const l of navigator.languages || [navigator.language || 'en']) {
      const base = String(l).split('-')[0];
      if (BY_CODE.has(l)) return l;
      if (base === 'zh') return /TW|HK|Hant/i.test(l) ? 'zh-Hant' : 'zh-Hans';
      if (base === 'no' || base === 'nn') return 'nb';
      if (BY_CODE.has(base)) return base;
    }
    return 'en';
  }

  let franc = null;
  function loadFranc() {
    if (!franc) {
      franc = new Promise((resolve, reject) => {
        if (window.NpFranc) { resolve(window.NpFranc); return; }
        const s = document.createElement('script');
        s.src = 'vendor/franc/franc.min.js';
        s.onload = () => resolve(window.NpFranc);
        s.onerror = () => reject(new Error(_('Could not load the language detector.')));
        document.head.append(s);
      });
      franc.catch(() => { franc = null; });
    }
    return franc;
  }

  // Only a sure answer is given: enough text, and one language clearly ahead.
  async function detect(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (t.length < 40) return null;
    // writing systems that are one language among ours
    if (/[぀-ヿ]/.test(t)) return 'ja';
    if (/[가-힯]/.test(t)) return 'ko';
    if (/[฀-๿]/.test(t)) return 'th';
    const F = await loadFranc();
    const only = LIST.filter((l) => l.iso3).map((l) => l.iso3);
    const ranked = F.francAll(t, { only, minLength: 40 });
    if (!ranked.length || ranked[0][0] === 'und') return null;
    // franc scores the best as 1 and the rest below it
    if (ranked[1] && ranked[1][1] > 0.95) return null;
    return BY_ISO3.get(ranked[0][0]) || null;
  }

  window.NpLang = {
    list: LIST,
    has: (code) => BY_CODE.has(code),
    name, native, preferred, detect,
    isRtl: (code) => !!(BY_CODE.get(code) && BY_CODE.get(code).rtl)
  };
})();
