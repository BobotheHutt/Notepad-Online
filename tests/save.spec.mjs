// Save and Save as. Where the browser can write to files (Chrome, Edge),
// Save writes back to the file a document came from or was saved as;
// elsewhere every save is a copy in Downloads.
import fs from 'node:fs';
import { test, expect, fixture, putFile, getFile, saveAsType } from './helpers.mjs';

const isJpeg = (b) => b && b[0] === 0xff && b[1] === 0xd8;
const isZip = (b) => b && b[0] === 0x50 && b[1] === 0x4b;

test.describe('where the browser can write to files', () => {
  test.use({ filePickers: true });
  // the File System Access API: Chrome and Edge only
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chrome and Edge only');

  test('an opened JPG: Save writes back to it, still after a reload', async ({ app: p }) => {
    const original = fs.readFileSync(fixture('scan.jpg'));
    await putFile(p, 'scan.jpg', original);
    await p.evaluate(() => { window.__openName = 'scan.jpg'; });
    await p.click('.menu-btn:has-text("File")');
    await p.click('[data-action="open"]');
    await p.waitForSelector('.pdf-page canvas');
    await expect(p.locator('#save-item')).toContainText('Save to “scan.jpg”');
    // a note on the picture, then Save
    const bb = await p.locator('.pdf-page').first().boundingBox();
    await p.click('[data-pdf-tool="text"]');
    await p.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height * 0.8);
    await p.keyboard.type('Approved'); await p.keyboard.press('Escape');
    await p.keyboard.press('Control+s');
    await expect(p.locator('#toast')).toContainText('Saved to “scan.jpg”', { timeout: 30000 });
    const saved = await getFile(p, 'scan.jpg');
    expect(isJpeg(saved)).toBe(true);
    expect(Buffer.from(saved).equals(original)).toBe(false);
    expect(await p.evaluate(() => window.__picked.length)).toBe(0); // no dialog: it went straight back
  });

  // The link lasts the visit: after a reload the first Save asks again (with
  // the same name), as Chromium can crash reading a stored file link back.
  test('after a reload, the first Save asks again, then goes straight there', async ({ app: p }) => {
    await p.click('#editor'); await p.keyboard.type('# Kept'); await p.keyboard.press('Enter'); await p.keyboard.type('Before.');
    await p.keyboard.press('Control+s');
    await expect(p.locator('#toast')).toContainText('Saved to “Kept.docx”');
    await p.reload(); await p.waitForSelector('body.ready');
    await expect(p.locator('#save-item span')).toHaveText('Save');
    await p.click('#editor'); await p.keyboard.press('Control+End'); await p.keyboard.type(' After.');
    await p.keyboard.press('Control+s');
    await expect(p.locator('#toast')).toContainText('Saved to “Kept.docx”');
    expect(await p.evaluate(() => window.__picked)).toEqual(['Kept.docx']);
    await p.keyboard.type(' More.');
    await p.keyboard.press('Control+s');
    await expect(p.locator('#toast')).toContainText('Saved to “Kept.docx”');
    expect(await p.evaluate(() => window.__picked.length)).toBe(1);
  });

  test('a new document: the first Save asks where, the next goes straight there', async ({ app: p }) => {
    await p.click('#editor');
    await p.keyboard.type('# Plans'); await p.keyboard.press('Enter'); await p.keyboard.type('First draft.');
    await p.keyboard.press('Control+s');
    await expect(p.locator('#toast')).toContainText('Saved to “Plans.docx”');
    expect(await p.evaluate(() => window.__picked)).toEqual(['Plans.docx']);
    const first = await getFile(p, 'Plans.docx');
    expect(isZip(first)).toBe(true);
    await p.keyboard.type(' Second draft.');
    await p.keyboard.press('Control+s');
    await expect.poll(async () => (await getFile(p, 'Plans.docx'))?.length).not.toBe(first.length); // null while the file is being written
    expect(await p.evaluate(() => window.__picked.length)).toBe(1);
    // Save as, picking Markdown in the dialog's type list, makes a second file, and Save follows it
    await p.evaluate(() => { window.__pickExt = 'md'; });
    await p.click('.menu-btn:has-text("File")');
    await p.click('[data-action="save-as"]');
    await expect(p.locator('#toast')).toContainText('Saved to “Plans.md”');
    expect(new TextDecoder().decode(new Uint8Array(await getFile(p, 'Plans.md')))).toContain('# Plans');
    await expect(p.locator('#save-item')).toContainText('Save to “Plans.md”');
    expect(await p.evaluate(() => window.__types)).toEqual(['Word document (.docx)', 'Web page (.html)', 'Markdown (.md)', 'Plain text (.txt)']);
  });

  test('cancelling Save as does nothing', async ({ app: p }) => {
    await p.click('#editor'); await p.keyboard.type('Unsaved words');
    await p.evaluate(() => { window.__cancelNext = true; });
    let downloaded = false;
    p.on('download', () => { downloaded = true; });
    await p.keyboard.press('Control+s');
    await p.waitForTimeout(800);
    expect(downloaded).toBe(false);
    await expect(p.locator('#save-item')).toHaveText(/^Save/);
    await expect(p.locator('#save-item span')).toHaveText('Save');
  });

  test('a Word file made elsewhere: Save asks before saving over it', async ({ app: p }) => {
    // a Word file, made by Noteshack as it happens, but opened as any other
    await p.click('#editor'); await p.keyboard.type('From another program');
    await p.evaluate(() => { window.showSaveFilePicker = undefined; });
    const dl = await saveAsType(p, 'docx');
    await putFile(p, 'Report.docx', fs.readFileSync(await dl.path()));
    await p.reload(); await p.waitForSelector('body.ready');
    await p.evaluate(() => { window.__openName = 'Report.docx'; });
    await p.keyboard.press('Control+o');
    await expect(p.locator('#editor')).toContainText('From another program');
    await p.keyboard.press('Control+End'); await p.keyboard.type(' and more');
    await p.keyboard.press('Control+s');
    const box = p.locator('dialog[open]');
    await expect(box).toContainText('Save over “Report.docx”?');
    await box.getByRole('button', { name: 'Save over it' }).click();
    await expect(p.locator('#toast')).toContainText('Saved to “Report.docx”');
    // asked once: the next Save just saves
    await p.keyboard.press('Control+s');
    await expect(p.locator('dialog[open]')).toHaveCount(0);
  });
});

test('elsewhere, Save puts a copy in Downloads, as the same kind of file', async ({ app: p }) => {
  await p.click('#editor'); await p.keyboard.type('# Notes'); await p.keyboard.press('Enter'); await p.keyboard.type('Plain words.');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.keyboard.press('Control+s')]);
  expect(dl.suggestedFilename()).toBe('Notes.docx');
  await expect(p.locator('#toast')).toContainText('Saved to your Downloads');
  await expect(p.locator('#save-status')).toHaveText('Saved in Noteshack');
});

test.describe('exporting, where the browser can write to files', () => {
  test.use({ filePickers: true });
  // the File System Access API: Chrome and Edge only
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chrome and Edge only');
  test('Export makes a separate file; Save keeps going to the original', async ({ app: p }) => {
    await putFile(p, 'letter.pdf', fs.readFileSync(fixture('letter.pdf')));
    await p.evaluate(() => { window.__openName = 'letter.pdf'; });
    await p.keyboard.press('Control+o');
    await p.waitForSelector('.pdf-page canvas');
    await p.evaluate(() => { window.__pickExt = 'txt'; });
    await p.evaluate(() => document.querySelector('[data-action="export"]').click());
    await expect(p.locator('#toast')).toContainText('Exported to “letter.txt”', { timeout: 30000 });
    expect(await p.evaluate(() => window.__types[0])).toBe('Word document (.docx)'); // a PDF's exports: not PDF
    expect(new TextDecoder().decode(new Uint8Array(await getFile(p, 'letter.txt')))).toContain('Total due: $450.00');
    await expect(p.locator('#save-item span')).toHaveText('Save to “letter.pdf”');
  });
});
