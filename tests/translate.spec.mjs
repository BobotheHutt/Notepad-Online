// Translating a document into a copy, on this computer, and checking it.
import { test, expect, openFile, newestDoc } from './helpers.mjs';

// The models come from the tests' stand-in for files.noteshack.org (which
// answers only noteshack.org). In the test tool's WebKit, requests from a
// page the offline cache controls skip the stand-in, so the cache is left out.
test.use({ remote: true, serviceWorkers: 'block' });

const LETTER = '<h1>The meeting</h1>' +
  '<p>The council meeting will be held next <b>Tuesday</b> in the main hall.</p>' +
  '<ul><li>Bring your <a href="https://example.com/">invitation</a> to the door.</li></ul>' +
  '<p>Press the red button to start the machine, then run <code>npm start</code> again.</p>';

async function openHtml(p, name, html) {
  await p.setInputFiles('#file-open', { name, mimeType: 'text/html', buffer: Buffer.from('<!doctype html><title>x</title>' + html) });
  // the file's own words, not the blank document there before it
  await expect(p.locator('#doc-title')).toHaveValue(name.replace(/\.html$/, ''));
  await expect(p.locator('#editor')).toContainText(html.replace(/<[^>]+>/g, '').slice(0, 12));
}

async function translate(p, into, { engine, keep } = {}) {
  await p.click('.menu-btn:has-text("Tools")');
  await p.click('[data-action="translate"]');
  const dlg = p.locator('dialog[open]');
  await dlg.getByRole('radio', { name: new RegExp('^' + into) }).check();
  if (engine) await dlg.locator('input[name="tr-engine"][value="' + engine + '"]').check();
  if (keep != null) await dlg.getByLabel('Leave these as they are').fill(keep);
  await dlg.getByRole('button', { name: 'Translate' }).click();
}

test('a document becomes a translated copy, formatting kept, checked paragraph by paragraph', async ({ app: p }) => {
  test.setTimeout(240000);
  await openHtml(p, 'Letter.html', LETTER);
  await translate(p, 'Spanish', { keep: 'red button' });
  // the copy opens, in Spanish, with the original left alone
  await expect(p.locator('#doc-title')).toHaveValue(/\(Spanish\)$/, { timeout: 180000 });
  await expect(p.locator('.doc-item')).toHaveCount(2);
  const ed = p.locator('#editor');
  await expect(ed.locator('h1')).toHaveText(/reunión/i);
  await expect(ed.locator('b')).toHaveText('martes');
  await expect(ed.locator('a[href="https://example.com/"]')).toHaveCount(1);
  await expect(ed.locator('code')).toHaveText('npm start');
  await expect(ed).toContainText('red button'); // left as it is
  await expect(p.locator('#sb-lang')).toHaveText('Spanish');
  // every paragraph is marked until checked
  const review = p.locator('#review');
  await expect(review).toBeVisible();
  await expect(p.locator('#review-count')).toHaveText('4 paragraphs to check');
  await ed.locator('h1').click();
  await expect(p.locator('#review-orig')).toHaveText('The meeting');
  await review.getByRole('button', { name: 'Looks right' }).click();
  await expect(p.locator('#review-count')).toHaveText('3 paragraphs to check');
  await expect(ed.locator('h1[data-np-tr]')).toHaveCount(0);
  // the marks and originals are kept with the document
  await p.waitForTimeout(1200);
  await p.reload();
  await expect(p.locator('#review-count')).toHaveText('3 paragraphs to check');
  // change the original, translate again
  await ed.locator('li').click();
  await expect(p.locator('#review-orig')).toContainText('Bring your invitation');
  await p.locator('#review-orig').evaluate((o) => { o.querySelector('a').textContent = 'ticket'; o.dispatchEvent(new InputEvent('input', { bubbles: true })); });
  await review.getByRole('button', { name: 'Translate again' }).click();
  await expect(ed.locator('li')).not.toContainText('invitación', { timeout: 60000 });
  await expect(ed.locator('li a[href="https://example.com/"]')).toHaveCount(1);
  // Done: the marks go
  await review.getByRole('button', { name: 'Done' }).click();
  await p.locator('dialog[open]').getByRole('button', { name: 'Done' }).click();
  await expect(review).toBeHidden();
  await expect(ed.locator('[data-np-tr]')).toHaveCount(0);
  // the original is as it was
  await p.locator('.doc-item', { hasText: 'Letter' }).filter({ hasNotText: 'Spanish' }).first().click();
  await expect(ed.locator('h1')).toHaveText('The meeting');
  await expect(review).toBeHidden();
});

test('a model is downloaded once and kept', async ({ app: p }) => {
  test.setTimeout(240000);
  let fetched = 0;
  p.on('request', (r) => { if (r.url().startsWith('https://files.noteshack.org/')) fetched++; });
  await openHtml(p, 'Short.html', '<p>The weather is lovely today, so we are going for a long walk.</p>');
  await p.click('.menu-btn:has-text("Tools")');
  await p.click('[data-action="translate"]');
  const dlg = p.locator('dialog[open]');
  await dlg.getByRole('radio', { name: /^Spanish/ }).check();
  await expect(dlg).toContainText(/Downloads \d+ MB the first time/);
  await dlg.getByRole('button', { name: 'Translate' }).click();
  await expect(p.locator('#doc-title')).toHaveValue(/\(Spanish\)$/, { timeout: 180000 });
  await expect(p.locator('#editor')).toContainText(/paseo|caminata/);
  expect(fetched).toBe(3);
  expect(await p.evaluate(async () => (await (await caches.open('np-translate-v1')).keys()).length)).toBe(3);
  // a second time: nothing to download
  await p.locator('.doc-item').last().click();
  await p.click('.menu-btn:has-text("Tools")');
  await p.click('[data-action="translate"]');
  await p.locator('dialog[open]').getByRole('radio', { name: /^Spanish/ }).check();
  await expect(p.locator('dialog[open]')).not.toContainText('Downloads');
  await p.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
  expect(fetched).toBe(3);
});

test('the browser’s own translator, where there is one, for more languages', async ({ app: p }) => {
  // a stand-in for Chrome's built-in translator
  await p.addInitScript(() => {
    window.Translator = {
      availability: async ({ sourceLanguage, targetLanguage }) => (sourceLanguage === 'en' && targetLanguage === 'ja' ? 'available' : 'unavailable'),
      create: async () => ({ translate: async (t) => '【' + t + '】', destroy() {} })
    };
  });
  await p.reload();
  await openHtml(p, 'Plain.html', '<p>Good morning to <b>everyone</b> here.</p><p>See you at Noteshack tomorrow.</p>');
  await translate(p, 'Japanese', { keep: 'Noteshack' });
  await expect(p.locator('#doc-title')).toHaveValue(/\(Japanese\)$/, { timeout: 30000 });
  const ed = p.locator('#editor');
  // plain text: the bold inside the paragraph is not kept; the kept name is
  // left out of what the translator sees
  await expect(ed.locator('p').first()).toHaveText('【Good morning to everyone here.】');
  await expect(ed.locator('p').nth(1)).toHaveText('【See you at】 Noteshack 【tomorrow.】');
  await expect(p.locator('#sb-lang')).toHaveText('Japanese');
});

// a downloaded PDF, opened again: what it reads as
async function reopen(p, dl, name) {
  const file = test.info().outputPath(name);
  await dl.saveAs(file);
  await p.setInputFiles('#file-open', file);
  await p.waitForSelector('.pdf-page canvas');
  await p.waitForTimeout(800);
  return newestDoc(p, name.replace(/\.pdf$/, ''));
}

async function translatePdf(p, kind, from) {
  await p.click('.menu-btn:has-text("Tools")');
  await p.click('[data-action="translate"]');
  const dlg = p.locator('dialog[open]');
  // a scan not read yet: its language is not known, so it is chosen
  if (from) await dlg.getByLabel('Translate from').selectOption(from);
  await dlg.getByRole('radio', { name: /^English/ }).check();
  await dlg.locator('input[name="tr-kind"][value="' + kind + '"]').check();
  await dlg.getByRole('button', { name: 'Translate' }).click();
}

test('a typed PDF, translated keeping its layout', async ({ app: p }) => {
  test.setTimeout(240000);
  await openFile(p, 'carta.pdf');
  await translatePdf(p, 'layout');
  await expect(p.locator('#doc-title')).toHaveValue(/\(English\)$/, { timeout: 180000 });
  await expect(p.locator('#toast')).toContainText('Translated, keeping the layout', { timeout: 180000 });
  await expect(p.locator('#sb-lang')).toHaveText('English');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  const doc = await reopen(p, dl, 'letter-en.pdf');
  expect(doc.pages).toBe(1);
  expect(doc.text).toMatch(/order/i);
  expect(doc.text).toMatch(/Tuesday/);
  expect(doc.text).not.toMatch(/pedido|martes/);
});

test('a PDF\u2019s words, translated into a document to check', async ({ app: p }) => {
  test.setTimeout(240000);
  await openFile(p, 'carta.pdf');
  await translatePdf(p, 'doc');
  await expect(p.locator('#doc-title')).toHaveValue(/\(English\)$/, { timeout: 180000 });
  await expect(p.locator('#editor')).toContainText(/Tuesday/);
  await expect(p.locator('#review')).toBeVisible();
  await p.locator('#editor p, #editor h1, #editor h2').filter({ hasText: 'Tuesday' }).first().click();
  await expect(p.locator('#review-orig')).toContainText('martes');
});

test('a scanned PDF is read, then translated keeping its layout', async ({ app: p }) => {
  test.setTimeout(300000);
  await openFile(p, 'scan-es.pdf');
  await translatePdf(p, 'layout', 'es');
  await expect(p.locator('#toast')).toContainText('Translated, keeping the layout', { timeout: 280000 });
  await expect(p.locator('.pdf-conv').first()).toBeVisible();
  const words = await p.locator('.pdf-conv').allTextContents();
  expect(words.join(' ')).toMatch(/meeting|Wednesday/i);
  expect(words.join(' ')).not.toMatch(/reunión|miércoles/);
});

test('a paragraph that runs longer in translation stays in its own space', async ({ app: p }) => {
  test.setTimeout(240000);
  await openFile(p, 'memo.pdf');
  await p.click('.menu-btn:has-text("Tools")');
  await p.click('[data-action="translate"]');
  const dlg = p.locator('dialog[open]');
  await dlg.getByRole('radio', { name: /^Spanish/ }).check();
  await dlg.getByRole('button', { name: 'Translate' }).click();
  await expect(p.locator('#toast')).toContainText('Translated, keeping the layout', { timeout: 180000 });
  await p.waitForTimeout(1200);
  const doc = await newestDoc(p);
  const lines = doc.items.filter((i) => i.text).sort((a, b) => a.base - b.base);
  // the same lines it had: four for the paragraph, then the signature
  expect(lines.map((l) => Math.round(l.base))).toEqual(doc.items.map((i) => Math.round(i.base)).filter((b, k, a) => a.indexOf(b) === k).sort((a, b) => a - b));
  expect(lines).toHaveLength(5);
  // the paragraph is set a little smaller; the signature keeps its size
  for (const l of lines.slice(0, 4)) { expect(l.size).toBeLessThan(11); expect(l.size).toBeGreaterThanOrEqual(6.6); }
  expect(lines[4].size).toBe(11);
  expect(lines[4].text).toMatch(/Firmado|Firma/);
  expect(lines.map((l) => l.text).join(' ')).toMatch(/jueves/);
});
