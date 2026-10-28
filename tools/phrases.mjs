// The phrases Noteshack's code asks for in the app's language: every
// _('…') and _n(count, '…', '…') in js/. (The page's own text is collected
// in the browser, by NpI18n.domPhrases.) Used by tests/i18n.spec.mjs.
//
//   node tools/phrases.mjs     lists them
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIT = String.raw`'((?:[^'\\\n]|\\.)*)'`;
// a JavaScript string literal's value
const unquote = (s) => JSON.parse('"' + s.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');

export function jsPhrases() {
  const singles = new Set();
  const plurals = new Map(); // other → one
  const dir = path.join(ROOT, 'js');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(new RegExp(String.raw`(?<![\w.])_\(\s*` + LIT, 'g'))) singles.add(unquote(m[1]));
    for (const m of src.matchAll(new RegExp(String.raw`(?<![\w.])_n\([^,()]*(?:\([^()]*\))?[^,()]*,\s*` + LIT + String.raw`\s*,\s*` + LIT, 'g'))) plurals.set(unquote(m[2]), unquote(m[1]));
  }
  return { singles, plurals };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { singles, plurals } = jsPhrases();
  for (const s of [...singles].sort()) console.log(s);
  for (const [other, one] of plurals) console.log('[plural] ' + one + ' | ' + other);
}
