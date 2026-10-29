// Text in other scripts, written into saved PDFs: shaped, in order, with only
// the letters used embedded, and read back as it was typed.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { test, expect, openFile, newestDoc } from './helpers.mjs';

test.use({ remote: true });

// a downloaded PDF, opened again: what it reads as
async function reopen(p, dl, name) {
  const file = test.info().outputPath(name);
  await dl.saveAs(file);
  await p.setInputFiles('#file-open', file);
  const title = name.replace(/\.pdf$/, '');
  await expect(p.locator('#doc-title')).toHaveValue(title, { timeout: 30000 });
  await p.waitForSelector('.pdf-page canvas');
  await expect.poll(async () => !!(await newestDoc(p, title)), { timeout: 15000 }).toBe(true);
  return { doc: await newestDoc(p, title), bytes: fs.readFileSync(file) };
}

async function addLines(p, lines) {
  const bb = await p.locator('.pdf-page').first().boundingBox();
  for (const [i, t] of lines.entries()) {
    await p.click('[data-pdf-tool="text"]');
    await p.mouse.click(bb.x + 80, bb.y + 300 + i * 50);
    await p.keyboard.insertText(t);
    await p.keyboard.press('Escape');
  }
}

const LINES = [
  'مرحبا بالعالم، هذا اختبار 123', // Arabic: joined letters, right to left
  'שלום עולם', // Hebrew
  'नमस्ते दुनिया क्षत्रिय', // Hindi: conjuncts and vowel signs
  '你好，世界。中文测试', // Chinese, from a 10 MB font
  'Привет, мир Ελληνικά tiếng Việt', // Cyrillic, Greek, Vietnamese
  'Mixed English مع العربية here' // both directions in one line
];

test('text in any script is saved shaped and small, and reads back as typed', async ({ app: p }) => {
  test.setTimeout(240000);
  await openFile(p, 'letter.pdf');
  await addLines(p, LINES);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  const { doc, bytes } = await reopen(p, dl, 'scripts-out.pdf');
  // (a number in a right-to-left line is read in the order it stands)
  for (const line of LINES) for (const part of line.split(/ ?123/)) expect(doc.text).toContain(part);
  expect(doc.text).not.toContain('?');
  // the fonts are cut down to the letters used: the Chinese one is 10 MB whole
  expect(bytes.length).toBeLessThan(80000);
  // the font names, from the file's streams (pdf-lib packs its objects into them)
  let latin1 = bytes.toString('latin1');
  for (const m of latin1.matchAll(/stream\r?\n/g)) {
    try { latin1 += zlib.inflateSync(bytes.subarray(m.index + m[0].length)).toString('latin1'); } catch (e) { /* not deflated */ }
  }
  for (const f of ['NotoSansArabic', 'NotoSansHebrew', 'NotoSansDevanagari', 'NotoSansSC', 'NotoSans-']) expect(latin1).toMatch(new RegExp('/[A-Z]{6}\\+' + f));
});

test('a font that cannot be downloaded: the text becomes question marks, and it is said', async ({ app: p, errors }) => {
  test.setTimeout(120000);
  await p.route(/files\.noteshack\.org\/fonts\//, (route) => route.fulfill({ status: 404, body: '' }));
  await openFile(p, 'letter.pdf');
  await addLines(p, ['שלום עולם']);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  await expect(p.locator('#toast')).toContainText('could not be downloaded', { timeout: 30000 });
  // the font's failed downloads, which this test caused
  errors.splice(0, errors.length, ...errors.filter((e) => !/404/.test(e)));
  const { doc } = await reopen(p, dl, 'offline-out.pdf');
  expect(doc.text).toContain('???? ????');
});

test('a translation into Japanese breaks its lines between words, and keeps to them', async ({ app: p }) => {
  test.setTimeout(240000);
  const JA = '建物の維持管理予算の四半期ごとの見直しは、来週木曜日の朝、三階の大会議室で行われます。各部門長は、一月以降に行われた修理の短い概要と、まだ承認待ちの作業の一覧を持参してください。';
  await p.addInitScript((ja) => {
    window.Translator = {
      availability: async ({ sourceLanguage, targetLanguage }) => (sourceLanguage === 'en' && targetLanguage === 'ja' ? 'available' : 'unavailable'),
      create: async () => ({ translate: async (t) => (/^Signed/.test(t) ? '署名：施設管理室' : ja), destroy() {} })
    };
  }, JA);
  await p.reload();
  await openFile(p, 'memo.pdf');
  await p.click('.menu-btn:has-text("Tools")');
  await p.click('[data-action="translate"]');
  const dlg = p.locator('dialog[open]');
  await dlg.getByRole('radio', { name: /^Japanese/ }).check();
  await dlg.getByRole('button', { name: 'Translate' }).click();
  await expect(p.locator('#toast')).toContainText('Translated, keeping the layout', { timeout: 120000 });
  await p.waitForTimeout(1200);
  const doc = await newestDoc(p);
  const lines = doc.items.filter((i) => i.text).sort((a, b) => a.base - b.base);
  const para = lines.slice(0, -1);
  // the paragraph within its four lines (Japanese runs shorter), split
  // between words, in order; then the signature
  expect(para.length).toBeGreaterThanOrEqual(2);
  expect(para.length).toBeLessThanOrEqual(4);
  expect(para.map((l) => l.text).join('')).toBe(JA);
  for (const l of para) expect(l.text.length).toBeLessThan(JA.length * 0.6);
  for (const l of para.slice(1)) expect(l.text).not.toMatch(/^[、。]/);
  expect(lines[lines.length - 1].text).toBe('署名：施設管理室');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  const { doc: saved } = await reopen(p, dl, 'memo-ja.pdf');
  expect(saved.text.replace(/\s+/g, '')).toContain(JA.slice(0, 20));
});
