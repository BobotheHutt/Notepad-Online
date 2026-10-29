/* Noteshack — spell checking in the document's language.

   The browser's own spell check cannot be told which language to use, so
   for the languages Noteshack has a dictionary for it checks spelling
   itself, on this computer (js/spellworker.js), and underlines the words
   with the browser's highlight feature. For other languages the browser's
   own spell check stays on.

   NpSpell.has(lang)                a dictionary for that language
   NpSpell.check(lang, words)       the words that are misspelled
   NpSpell.suggest(lang, word)      corrections, best first
   NpSpell.learn(lang, word)        add to the person's own dictionary (kept) */
(function () {
  'use strict';
  const _ = NpI18n.t; // the app's own language (js/i18n.js)

  const LANGS = new Set(['en', 'es', 'fr', 'de', 'pt', 'it']);
  const OWN_KEY = 'np.dict.'; // + lang: the person's own words, kept in this browser

  let worker = null;
  let seq = 0;
  const waiting = new Map();
  function ask(msg) {
    if (!worker) {
      worker = new Worker('js/spellworker.js?' + window.NP_V, { type: 'module' });
      worker.onmessage = (e) => {
        const w = waiting.get(e.data.id);
        if (!w) return;
        waiting.delete(e.data.id);
        if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data);
      };
      worker.onerror = () => { for (const w of waiting.values()) w.reject(new Error(_('Spell checking stopped'))); waiting.clear(); worker = null; };
    }
    const id = ++seq;
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage(Object.assign({ id }, msg)); });
  }

  const own = (lang) => { try { return JSON.parse(localStorage.getItem(OWN_KEY + lang) || '[]'); } catch (e) { return []; } };
  const known = new Map(); // lang → Map(word → correct?)
  const loaded = new Map(); // lang → Promise: the person's own words added to the engine

  function ready(lang) {
    if (!loaded.has(lang)) {
      loaded.set(lang, own(lang).length ? ask({ op: 'add', lang, words: own(lang) }) : Promise.resolve());
      loaded.get(lang).catch(() => loaded.delete(lang));
    }
    return loaded.get(lang);
  }

  async function check(lang, words) {
    if (!LANGS.has(lang)) return [];
    if (!known.has(lang)) known.set(lang, new Map());
    const k = known.get(lang);
    const todo = [...new Set(words)].filter((w) => !k.has(w));
    if (todo.length) {
      await ready(lang);
      const { bad } = await ask({ op: 'check', lang, words: todo });
      const badSet = new Set(bad);
      for (const w of todo) k.set(w, !badSet.has(w));
    }
    return words.filter((w) => k.get(w) === false);
  }

  async function suggest(lang, word) {
    if (!LANGS.has(lang)) return [];
    await ready(lang);
    return (await ask({ op: 'suggest', lang, word })).list;
  }

  async function learn(lang, word) {
    const list = own(lang);
    if (!list.includes(word)) { list.push(word); try { localStorage.setItem(OWN_KEY + lang, JSON.stringify(list)); } catch (e) { /* kept for this visit */ } }
    if (known.has(lang)) known.get(lang).set(word, true);
    await ask({ op: 'add', lang, words: [word] });
  }

  window.NpSpell = { has: (lang) => LANGS.has(lang), check, suggest, learn };
})();
