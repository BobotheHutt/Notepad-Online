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

// Files from files.noteshack.org: translation models and fonts. It answers
// only pages on noteshack.org, so the tests fetch them here and hand them to
// the page; each is kept in tests/.fixtures/files after the first time, or
// comes from NOTESHACK_FILES (a folder laid out as on the site:
// translate/v1/en-es/…, fonts/v1/NotoSansArabic/…) where the site is out of reach.
const FILES = process.env.NOTESHACK_FILES || path.join(ROOT, 'tests', '.fixtures', 'files');
async function remoteFiles(context) {
  await context.route(/^https:\/\/files\.noteshack\.org\//, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/gzip' };
    const file = path.join(FILES, new URL(route.request().url()).pathname);
    if (!fs.existsSync(file)) {
      const res = await route.fetch({ headers: { origin: 'https://noteshack.org' } });
      if (!res.ok()) return route.fulfill({ status: res.status(), body: '', headers });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const part = file + '.' + process.pid + '-' + Math.random().toString(36).slice(2) + '.part';
      fs.writeFileSync(part, await res.body());
      fs.renameSync(part, file);
    }
    return route.fulfill({ status: 200, body: fs.readFileSync(file), headers });
  });
}

export const test = base.extend({
  context: async ({ context, welcome, remote }, use) => {
    await localFonts(context);
    // only where asked: in Firefox, any stand-in keeps the offline cache from answering
    if (remote) await remoteFiles(context);
    // the welcome popup stays away unless a test is about it
    if (!welcome) await context.addInitScript(() => { try { localStorage.setItem('np.welcome', 'hidden'); localStorage.setItem('np.safari-note', 'shown'); } catch (e) { /* ignore */ } });
    await use(context);
  },
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
  // the welcome popup, off unless a test is about it
  welcome: [false, { option: true }],
  // files.noteshack.org, served from tests/.fixtures/files (see above)
  remote: [false, { option: true }],
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

export async function waitToast(page, re, timeout = 240000) {
  try {
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
  } catch (e) {
    // say where it stood, so a stall can be told from a slow machine
    const st = await page.evaluate(() => ({
      toast: document.getElementById('toast').textContent, status: document.getElementById('save-status').textContent,
      reading: document.querySelectorAll('.pdf-reading').length,
      editable: [...document.querySelectorAll('.pdf-page')].map((pg) => pg.querySelectorAll('.pdf-conv').length)
    })).catch(() => null);
    throw new Error('No message matching ' + re + ' in ' + timeout / 1000 + ' s. The page then: ' + JSON.stringify(st));
  }
}

// a document straight from IndexedDB: the one with this title, or the most
// recently saved (which can be another one saved a moment later)
export const newestDoc = (page, title) => page.evaluate(async (title) => {
  const db = await new Promise((r) => { const q = indexedDB.open('notepad-online'); q.onsuccess = () => r(q.result); });
  const all = await new Promise((r) => { const q = db.transaction('docs').objectStore('docs').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const d = title ? all.find((x) => x.title === title) : all.sort((a, b) => b.updated - a.updated)[0];
  return d && { id: d.id, type: d.type, title: d.title, text: d.text, pages: d.pages && d.pages.length, items: d.items, hasSources: !!d.sources };
}, title);

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
export const saveAsType = (page, kind) => chooseType(page, 'save-as', 'Save', kind);
// File → Export…, the same way
export const exportType = (page, kind) => chooseType(page, 'export', 'Export', kind);
async function chooseType(page, action, button, kind) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), (async () => {
    await page.evaluate((a) => document.querySelector(`[data-action="${a}"]`).click(), action);
    await page.locator('dialog[open] select').selectOption(kind);
    await page.locator('dialog[open]').getByRole('button', { name: button, exact: true }).click();
  })()]);
  return dl;
}
