// A file that will not open says so plainly, and leaves everything as it was.
import { test, expect, fixture } from './helpers.mjs';

const broken = [
  ['damaged.pdf', 'application/pdf', '%PDF-1.4\nthis is not really a PDF'],
  ['photo.jpg', 'image/jpeg', 'not a picture at all'],
  ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'not a Word file']
];

for (const [name, mimeType, text] of broken) {
  test(`a damaged ${name.split('.').pop().toUpperCase()} says it could not be opened`, async ({ app: p }) => {
    const before = await p.locator('.doc-item').count();
    await p.setInputFiles('#file-open', { name, mimeType, buffer: Buffer.from(text) });
    const box = p.locator('dialog[open]');
    await expect(box).toContainText(`Couldn’t open “${name}”`, { timeout: 30000 });
    await expect(box).toContainText('may be damaged');
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(p.locator('#save-status')).toHaveText('Saved in Noteshack');
    await expect(p.locator('.doc-item')).toHaveCount(before);
  });
}

test('a password-protected PDF says what to do', async ({ app: p }) => {
  await p.setInputFiles('#file-open', fixture('locked.pdf'));
  const box = p.locator('dialog[open]');
  await expect(box).toContainText('Couldn’t open “locked.pdf”', { timeout: 30000 });
  await expect(box).toContainText('password-protected');
});
