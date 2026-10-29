// The app in other languages: every phrase translated, plurals, choosing the
// language, the test language (every phrase marked, to find any left in
// English) and right to left.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test, expect, openFile } from './helpers.mjs';
import { jsPhrases } from '../tools/phrases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['es', 'fr', 'de', 'pt', 'it'];
const KEYS = ['Ctrl', 'Shift', 'Alt', 'Enter', 'Esc', 'Tab', 'Space'].map((k) => 'key:' + k);
const catalog = (lang) => {
  let cat = null;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'locales', lang + '.js'), 'utf8'), { NpI18n: { add: (c) => { cat = c; } } });
  return cat;
};
const holes = (s) => [...new Set(s.match(/\{\w+\}/g) || [])].sort().join(' ');

test('every phrase is translated, in every language, with its {placeholders}', async ({ app: p }) => {
  // the page's own text, as written in index.html
  const html = await p.evaluate(async () => NpI18n.domPhrases(new DOMParser().parseFromString(await (await fetch('index.html')).text(), 'text/html').body));
  const { singles, plurals } = jsPhrases();
  const want = new Set([...html, ...singles]);
  for (const other of plurals.keys()) want.delete(other);
  expect(want.size).toBeGreaterThan(500);
  for (const lang of LANGS) {
    const cat = catalog(lang);
    const missing = [...want].filter((k) => typeof cat[k] !== 'string');
    const missingPlurals = [...plurals.keys()].filter((k) => !cat[k] || typeof cat[k] !== 'object' || !cat[k].other);
    expect(missing, lang + ': phrases with no translation').toEqual([]);
    expect(missingPlurals, lang + ': plurals with no translation').toEqual([]);
    // nothing kept that the app no longer says
    const unused = Object.keys(cat).filter((k) => !want.has(k) && !plurals.has(k) && !KEYS.includes(k));
    expect(unused, lang + ': translations of phrases the app no longer has').toEqual([]);
    const wrong = [];
    for (const k of want) if (holes(cat[k]) !== holes(k)) wrong.push(k + ' → ' + cat[k]);
    for (const [other] of plurals) for (const f of Object.values(cat[other])) if (holes(f) !== holes(other)) wrong.push(other + ' → ' + f);
    expect(wrong, lang + ': placeholders that do not match the English').toEqual([]);
  }
});

test('in Spanish: menus, messages, plurals, numbers and names', async ({ app: p }) => {
  await p.goto('/?lang=es');
  await p.waitForSelector('body.ready');
  await expect(p.locator('.menu-btn').first()).toHaveText('Archivo');
  await expect(p.locator('html')).toHaveAttribute('lang', 'es');
  await p.click('#editor');
  await p.keyboard.type('Una frase corta para contar las palabras del documento. ');
  await expect(p.locator('#sb-count')).toHaveText('9 palabras');
  await expect(p.locator('#sb-lang')).toHaveText('Español', { timeout: 15000 });
  await expect(p.locator('#save-status')).toHaveText('Guardado en Noteshack');
  // a dialog built by the code
  await p.click('.menu-btn:has-text("Herramientas")');
  await p.click('[data-action="word-count"]');
  await expect(p.locator('dialog[open] h2')).toHaveText('Recuento de palabras');
  await p.keyboard.press('Escape');
  // a plural in French: 0 and 1 take the singular
  await p.goto('/?lang=fr');
  await p.waitForSelector('body.ready');
  expect(await p.evaluate(() => [0, 1, 2].map((n) => NpI18n.n(n, '{n} page', '{n} pages')))).toEqual(['0 page', '1 page', '2 pages']);
  expect(await p.evaluate(() => NpI18n.n(12345, '{n} word', '{n} words'))).toBe('12 345 mots');
  expect(await p.evaluate(() => [...NpI18n.missing])).toEqual([]);
});

test('the app language is chosen in View, kept, and Automatic follows the browser', async ({ app: p, browserName }) => {
  await p.click('.menu-btn:has-text("View")');
  await p.click('[data-action="app-lang"]');
  const dlg = p.locator('dialog[open]');
  await expect(dlg.getByRole('radio', { name: /^Automatic: English/ })).toBeChecked();
  await dlg.getByRole('radio', { name: 'Deutsch' }).check();
  await dlg.getByRole('button', { name: 'OK' }).click();
  await p.waitForSelector('body.ready');
  await expect(p.locator('.menu-btn').first()).toHaveText('Datei');
  await p.reload();
  await p.waitForSelector('body.ready');
  await expect(p.locator('.menu-btn').first()).toHaveText('Datei');
  // shortcut keys as German keyboards name them
  await expect(p.locator('#save-item kbd')).toHaveText('Strg+S');
  // back to Automatic
  await p.click('.menu-btn:has-text("Ansicht")');
  await p.click('[data-action="app-lang"]');
  await p.locator('dialog[open]').getByRole('radio', { name: /^Automatisch/ }).check();
  await p.locator('dialog[open]').getByRole('button', { name: 'OK' }).click();
  await p.waitForSelector('body.ready');
  await expect(p.locator('.menu-btn').first()).toHaveText('File');
});

test.describe('the browser in Italian', () => {
  test.use({ locale: 'it-IT' });
  test('starts in Italian', async ({ app: p }) => {
    await expect(p.locator('.menu-btn').first()).toHaveText('File');
    await expect(p.locator('.menu-btn').nth(1)).toHaveText('Modifica');
    await expect(p.locator('html')).toHaveAttribute('lang', 'it');
  });
});

// Every bit of the interface's text, in the test language, is marked: text
// still in plain English is a phrase the code does not translate.
async function plainEnglish(p, root) {
  return p.evaluate((sel) => {
    const out = [];
    const allowed = /^(Noteshack|PDF|OCR|Markdown|Regex|\d.*|[A-Z]|Ctrl\+.*|Shift\+.*|Alt\+.*|Esc|Tab|Delete|#.*|-.*|\[ \]|>|```|---|1\.)$/;
    for (const r of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || el.closest('#editor, #pdf-pages, .doc-list, [translate="no"], kbd, code, select, option, .lang-name, .lang-native, [lang]:not(html)') || !el.getClientRects().length) continue;
        const t = n.nodeValue.trim();
        if (!/\p{L}/u.test(t) || allowed.test(t) || t.includes('[') || /[‮‬]/.test(t)) continue;
        out.push(t);
      }
    }
    return out;
  }, root);
}

test('the test language leaves no phrase in English', async ({ app: p }) => {
  await p.goto('/?lang=en-XA');
  await p.waitForSelector('body.ready');
  expect(await plainEnglish(p, '.topbar, .toolbar, .statusbar, .sidebar')).toEqual([]);
  // every menu
  const menus = p.locator('.menu-btn');
  for (let i = 0; i < await menus.count(); i++) {
    if (!(await menus.nth(i).isVisible())) continue;
    await menus.nth(i).click();
    expect(await plainEnglish(p, '.menu.open .menu-pop')).toEqual([]);
    await p.keyboard.press('Escape');
  }
  // dialogs the code builds
  for (const action of ['word-count', 'translate', 'shortcuts', 'report', 'about', 'storage', 'app-lang', 'page-setup', 'history']) {
    await p.locator('.menu', { has: p.locator('[data-action="' + action + '"]') }).locator('.menu-btn').click();
    await p.click('.menu.open [data-action="' + action + '"]');
    await expect(p.locator('dialog[open]')).toBeVisible();
    expect(await plainEnglish(p, 'dialog[open]'), action).toEqual([]);
    await p.keyboard.press('Escape');
    await expect(p.locator('dialog[open]')).toHaveCount(0);
  }
  // the PDF editor
  await openFile(p, 'letter.pdf');
  expect(await plainEnglish(p, '.pdf-toolbar, .pdf-thumbs, .statusbar')).toEqual([]);
});

test('right to left: the interface mirrors, documents and PDFs keep their own direction', async ({ app: p }) => {
  await p.goto('/?lang=ar-XB');
  await p.waitForSelector('body.ready');
  await expect(p.locator('html')).toHaveAttribute('dir', 'rtl');
  const side = await p.locator('#sidebar').boundingBox();
  const pageBox = await p.locator('#page').boundingBox();
  expect(side.x).toBeGreaterThan(pageBox.x); // the documents panel is on the right
  // an English document still runs left to right
  await p.click('#editor');
  await p.keyboard.type('The meeting will be held next Tuesday in the main hall of the town. ');
  await expect(p.locator('#editor')).toHaveAttribute('dir', 'ltr', { timeout: 15000 });
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await openFile(p, 'letter.pdf');
  expect(await p.locator('.pdf-page').first().evaluate((n) => getComputedStyle(n).direction)).toBe('ltr');
});
