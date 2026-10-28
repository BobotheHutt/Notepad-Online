/* Noteshack — spell checking, off the page (a module worker).
   Hunspell, the engine LibreOffice uses (vendor/hunspell, compiled to
   WebAssembly), with Hunspell dictionaries (vendor/dictionaries). One engine
   per language, made the first time that language is checked.

   Messages in:  { id, op: 'check', lang, words }   → { id, bad: [words] }
                 { id, op: 'suggest', lang, word }  → { id, list: [words] }
                 { id, op: 'add', lang, words }     → { id }  (the person's own words) */
import { createHunspellFromStrings } from '../vendor/hunspell/dist/Hunspell.js';

const engines = new Map(); // lang → Promise<Hunspell>

function engine(lang) {
  if (!engines.has(lang)) {
    engines.set(lang, (async () => {
      const get = async (name) => {
        const res = await fetch('../vendor/dictionaries/' + lang + '/' + name);
        if (!res.ok) throw new Error('No dictionary for ' + lang);
        return res.text();
      };
      const [aff, dic] = await Promise.all([get('index.aff'), get('index.dic')]);
      return createHunspellFromStrings(aff, dic);
    })());
    engines.get(lang).catch(() => engines.delete(lang));
  }
  return engines.get(lang);
}

self.onmessage = async (e) => {
  const { id, op, lang } = e.data;
  try {
    const h = await engine(lang);
    if (op === 'check') self.postMessage({ id, bad: e.data.words.filter((w) => !h.testSpelling(w)) });
    else if (op === 'suggest') self.postMessage({ id, list: h.getSpellingSuggestions(e.data.word).slice(0, 6) });
    else if (op === 'add') { for (const w of e.data.words) h.addWord(w); self.postMessage({ id }); }
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
