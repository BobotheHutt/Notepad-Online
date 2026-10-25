// A PDF (or an image, which opens as one) saved as another kind of file.
import fs from 'node:fs';
import { test, expect, openFile, waitToast, saveAsType } from './helpers.mjs';

const text = async (dl) => fs.readFileSync(await dl.path(), 'utf8');

test('a PDF as plain text, and as a Word document that opens with its heading', async ({ app: p }) => {
  await openFile(p, 'letter.pdf');
  const txt = await saveAsType(p, 'txt');
  expect(txt.suggestedFilename()).toBe('letter.txt');
  const t = await text(txt);
  for (const w of ['Invoice 1042', 'Dear Ms. Rivera, thank you for your order.', 'Total due: $450.00', 'Page two text']) expect(t).toContain(w);
  const docx = await saveAsType(p, 'docx');
  expect(docx.suggestedFilename()).toBe('letter.docx');
  const file = test.info().outputPath('letter.docx');
  await docx.saveAs(file);
  await p.setInputFiles('#file-open', file);
  await expect(p.locator('#editor h1')).toHaveText('Invoice 1042');
  await expect(p.locator('#editor')).toContainText('Total due: $450.00');
  await expect(p.locator('#editor')).toContainText('Page two text');
});

test('a PDF as images: two pages make a zip of two PNGs', async ({ app: p }) => {
  await openFile(p, 'letter.pdf');
  const dl = await saveAsType(p, 'png');
  expect(dl.suggestedFilename()).toBe('letter.zip');
  const zip = fs.readFileSync(await dl.path());
  expect(zip.subarray(0, 2).toString()).toBe('PK');
  expect((zip.toString('latin1').match(/letter - page \d\.png/g) || []).length).toBeGreaterThanOrEqual(2);
  const tif = await saveAsType(p, 'tiff');
  expect(tif.suggestedFilename()).toBe('letter.tif');
});

test('a read scan as text carries what was read', async ({ app: p }) => {
  await openFile(p, 'scan.jpg');
  await p.click('label[for="pdf-readall"]');
  await waitToast(p, /whole document is read/);
  const t = await text(await saveAsType(p, 'txt'));
  for (const w of ['APPLICATION', 'John Example', 'Springfield']) expect(t).toContain(w);
});
