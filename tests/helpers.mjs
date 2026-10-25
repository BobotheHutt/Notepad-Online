// Shared by every test: the app loaded and ready, and a check at the end that
// nothing went wrong in the page that the test itself did not look for.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// made fresh each run (global-setup.mjs), or kept in tests/files/ when they
// need a tool the setup does not have (scan-fax.pdf: a fax-compressed scan of
// the made-up form, by ImageMagick)
export const fixture = (name) => path.join(ROOT, 'tests', fs.existsSync(path.join(ROOT, 'tests', 'files', name)) ? 'files' : '.fixtures', name);

// Where cdn.jsdelivr.net is out of reach, NOTESHACK_FONTS can name a folder
// holding the same @fontsource packages to serve from instead.
async function localFonts(context) {
  const dir = process.env.NOTESHACK_FONTS;
  if (!dir) return;
  await context.route(/cdn\.jsdelivr\.net\/npm\/@fontsource\//, (route) => {
    const m = route.request().url().match(/@fontsource\/([^/]+)\/(.+)$/);
    const file = m && path.join(dir, m[1], m[2]);
    if (file && fs.existsSync(file)) {
      return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'access-control-allow-origin': '*', 'content-type': /json$/.test(file) ? 'application/json' : 'font/woff2' } });
    }
    return route.fulfill({ status: 404, body: '', headers: { 'access-control-allow-origin': '*' } });
  });
}

export const test = base.extend({
  context: async ({ context }, use) => { await localFonts(context); await use(context); },
  errors: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // anything the security policy blocks
    await page.exposeFunction('__cspViolation', (v) => errors.push('blocked by the security policy: ' + v));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__cspViolation(e.violatedDirective + ' ' + e.blockedURI)));
    await use(errors);
    expect(errors, 'errors in the page').toEqual([]);
  },
  // Whether the browser can write to files on disk (Chrome and Edge can;
  // Firefox and Safari cannot). Off by default, so Save puts a copy in
  // Downloads. On, the save and open dialogs hand out files in the browser's
  // private storage (OPFS): real, writable files, as a test cannot click a
  // system dialog.
  filePickers: [false, { option: true }],
  app: async ({ page, errors, filePickers }, use) => {
    if (!filePickers) await page.addInitScript(() => { window.showSaveFilePicker = undefined; window.showOpenFilePicker = undefined; });
    else {
      await page.addInitScript(() => {
        window.__picked = [];
        window.showSaveFilePicker = async (o) => {
          if (window.__cancelNext) { window.__cancelNext = false; throw new DOMException('cancelled', 'AbortError'); }
          window.__picked.push(o.suggestedName);
          window.__types = o.types.map((t) => t.description);
          // the type picked in the dialog's list shows in the name's ending
          const name = window.__pickExt ? o.suggestedName.replace(/\.[^.]+$/, '.' + window.__pickExt) : o.suggestedName;
          window.__pickExt = null;
          return (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
        };
        window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle(window.__openName)];
      });
    }
    await page.goto('/');
    await page.waitForSelector('body.ready');
    await use(page);
  }
});
export { expect };

export async function openFile(page, name) {
  await page.setInputFiles('#file-open', fixture(name));
  await page.waitForSelector('.pdf-page canvas');
  await page.waitForTimeout(800);
}

export const waitToast = (page, re, timeout = 240000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });

// the most recently saved document, straight from IndexedDB
export const newestDoc = (page) => page.evaluate(async () => {
  const db = await new Promise((r) => { const q = indexedDB.open('notepad-online'); q.onsuccess = () => r(q.result); });
  const all = await new Promise((r) => { const q = db.transaction('docs').objectStore('docs').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const d = all.sort((a, b) => b.updated - a.updated)[0];
  return d && { id: d.id, type: d.type, title: d.title, text: d.text, pages: d.pages && d.pages.length, items: d.items, hasSources: !!d.sources };
});

export const saveNow = async (page) => { await page.keyboard.press('Control+s'); await page.waitForTimeout(1200); };

// files on disk, when filePickers is on
export const putFile = (page, name, bytes) => page.evaluate(async ([name, b64]) => {
  const h = await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
  const w = await h.createWritable(); await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); await w.close();
}, [name, Buffer.from(bytes).toString('base64')]);
export const getFile = (page, name) => page.evaluate(async (name) => {
  try { return [...new Uint8Array(await (await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()).arrayBuffer())]; } catch (e) { return null; }
}, name);

// File → Save as…, where the browser has no Save dialog: pick the type in
// Noteshack's own, and the file arrives as a download
export async function saveAsType(page, kind) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), (async () => {
    await page.evaluate(() => document.querySelector('[data-action="save-as"]').click());
    await page.locator('dialog[open] select').selectOption(kind);
    await page.locator('dialog[open]').getByRole('button', { name: 'Save', exact: true }).click();
  })()]);
  return dl;
}
