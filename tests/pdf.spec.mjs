import { test, expect, openFile, newestDoc, fixture } from './helpers.mjs';

// a downloaded PDF, opened again in the app: what it reads as
async function reopen(p, dl, name) {
  const file = test.info().outputPath(name);
  await dl.saveAs(file);
  await p.setInputFiles('#file-open', file);
  await p.waitForSelector('.pdf-page canvas');
  await p.waitForTimeout(800);
  return newestDoc(p, name.replace(/\.pdf$/, ''));
}

test('a typed PDF: edit its text, and the download carries the change', async ({ app: p }) => {
  await openFile(p, 'letter.pdf');
  await expect(p.locator('.pdf-page')).toHaveCount(2);
  // a PDF with no scanned page has no use for reading
  await expect(p.locator('#pdf-readall-wrap')).toBeHidden();
  await p.click('[data-pdf-tool="edit"]');
  await p.locator('.pdf-target[aria-label^="Edit: Total due"]').first().click();
  const box = p.locator('.pdf-textbox.editing');
  await expect(box).toContainText('Total due: $450.00');
  await p.evaluate(() => { const n = document.querySelector('.pdf-textbox.editing'); n.textContent = 'Total due: $512.00'; });
  await p.keyboard.press('Escape');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  const doc = await reopen(p, dl, 'letter-out.pdf');
  expect(doc.pages).toBe(2);
  expect(doc.text).toContain('$512.00');
  expect(doc.text).not.toContain('$450.00');
});

test('boxes and notes, with undo and redo', async ({ app: p }) => {
  await openFile(p, 'letter.pdf');
  const bb = await p.locator('.pdf-page').first().boundingBox();
  await p.click('[data-pdf-tool="box"]');
  await p.mouse.move(bb.x + 100, bb.y + 400); await p.mouse.down(); await p.mouse.move(bb.x + 220, bb.y + 470, { steps: 3 }); await p.mouse.up();
  await expect(p.locator('.pdf-box')).toHaveCount(1);
  await p.click('[data-pdf-tool="text"]');
  await p.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height * 0.6);
  await p.keyboard.type('A note added here'); await p.keyboard.press('Escape');
  await p.click('[data-pdf="undo"]');
  await p.click('[data-pdf="undo"]');
  await expect(p.locator('.pdf-box')).toHaveCount(0);
  await p.click('[data-pdf="redo"]');
  await expect(p.locator('.pdf-box')).toHaveCount(1);
  await p.click('[data-pdf="redo"]');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  const doc = await reopen(p, dl, 'notes-out.pdf');
  expect(doc.text).toContain('A note added here');
});

test('filling a form', async ({ app: p }) => {
  await p.setInputFiles('#file-open', fixture('form.pdf'));
  await p.waitForSelector('.pdf-field');
  await p.locator('input.pdf-field[type=text]').fill('Jane Q. Public');
  await p.locator('input.pdf-field[type=text]').press('Tab');
  await p.locator('input.pdf-field[type=checkbox]').check();
  await p.locator('select.pdf-field').selectOption('Green');
  await p.locator('input.pdf-field[type=radio]').nth(1).check();
  await p.waitForTimeout(500);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  await reopen(p, dl, 'form-out.pdf');
  await expect(p.locator('input.pdf-field[type=text]')).toHaveValue('Jane Q. Public');
  await expect(p.locator('input.pdf-field[type=checkbox]')).toBeChecked();
  await expect(p.locator('select.pdf-field')).toHaveValue('Green');
  await expect(p.locator('input.pdf-field[type=radio]').nth(1)).toBeChecked();
});

test('pages: rotate, add a blank page', async ({ app: p }) => {
  await openFile(p, 'letter.pdf');
  await p.click('.menu-btn:text("Pages")'); await p.click('[data-action="pdf-rotate"][data-arg="1"]');
  await p.waitForTimeout(800);
  await p.evaluate(() => document.querySelector('[data-action="pdf-blank"]').click());
  await expect(p.locator('.pdf-page')).toHaveCount(3);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.pdf-download')]);
  const doc = await reopen(p, dl, 'pages-out.pdf');
  expect(doc.pages).toBe(3);
});
