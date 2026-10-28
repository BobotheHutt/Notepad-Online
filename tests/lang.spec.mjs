// A document's own language: found from its text, or chosen; it sets the
// way text runs, and goes into saved files.
import fs from 'node:fs';
import { test, expect, openFile, saveAsType } from './helpers.mjs';

const SPANISH = 'La reunión del consejo se celebrará el próximo martes en la sala principal del ayuntamiento, y todos los vecinos están invitados a participar.';

test('found from the text, kept, and written into saved files', async ({ app: p }) => {
  await p.click('#editor');
  await p.keyboard.type(SPANISH);
  await expect(p.locator('#sb-lang')).toHaveText('Spanish', { timeout: 15000 });
  await expect(p.locator('#editor')).toHaveAttribute('lang', 'es');
  await p.reload(); await p.waitForSelector('body.ready');
  await expect(p.locator('#sb-lang')).toHaveText('Spanish');
  const html = await saveAsType(p, 'html');
  expect(fs.readFileSync(await html.path(), 'utf8')).toContain('<html lang="es">');
  const docx = await saveAsType(p, 'docx');
  const lang = await p.evaluate(async (b64) => {
    const zip = await NpZip.read(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    return ((await zip.text('word/styles.xml')).match(/w:lang w:val="([^"]+)"/) || [])[1];
  }, fs.readFileSync(await docx.path()).toString('base64'));
  expect(lang).toBe('es');
});

test('chosen by hand, it stays; right-to-left languages run that way', async ({ app: p }) => {
  await p.click('#editor');
  await p.click('#sb-lang');
  const box = p.locator('dialog[open]');
  await box.getByPlaceholder('Find a language').fill('arab');
  await box.locator('.lang-row:visible').first().click();
  await box.getByRole('button', { name: 'OK' }).click();
  await expect(p.locator('#sb-lang')).toHaveText('Arabic');
  await expect(p.locator('#editor')).toHaveAttribute('dir', 'rtl');
  // English text does not change a language chosen by hand
  await p.click('#editor');
  await p.keyboard.type('This sentence is plainly written in English, which would normally change the language that was detected.');
  await p.keyboard.press('Control+s').catch(() => {});
  await p.waitForTimeout(1500);
  await expect(p.locator('#sb-lang')).toHaveText('Arabic');
});

test('a PDF gets its language from its text', async ({ app: p }) => {
  await openFile(p, 'carta.pdf');
  await expect(p.locator('#sb-lang')).toHaveText('Spanish');
  await openFile(p, 'letter.pdf');
  await expect(p.locator('#sb-lang')).toHaveText('English');
});
