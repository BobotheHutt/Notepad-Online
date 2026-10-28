import { test, expect } from './helpers.mjs';

test.use({ welcome: true });

test('the welcome shows each visit until "Don’t show this again" is ticked', async ({ app: p }) => {
  const box = p.locator('dialog[open]');
  await expect(box).toContainText('Welcome to Noteshack');
  await expect(box).toContainText('Scans become editable');
  await box.getByRole('button', { name: 'Get started' }).click();
  await p.reload(); await p.waitForSelector('body.ready');
  await expect(box).toContainText('Welcome to Noteshack');
  await box.getByText('Don’t show this again').click();
  await box.getByRole('button', { name: 'Get started' }).click();
  await p.reload(); await p.waitForSelector('body.ready');
  await p.waitForTimeout(500);
  await expect(p.locator('dialog[open]')).toHaveCount(0);
});

test('Safari users are told once how to keep their documents', async ({ app: p, browserName }) => {
  test.skip(browserName !== 'webkit', 'Safari only');
  const box = p.locator('dialog[open]');
  await box.getByText('Don’t show this again').click();
  await box.getByRole('button', { name: 'Get started' }).click();
  await expect(box).toContainText('Keeping your documents in Safari');
  await expect(box).toContainText('7 days');
  await box.getByRole('button', { name: 'Got it' }).click();
  await p.reload(); await p.waitForSelector('body.ready');
  await p.waitForTimeout(500);
  await expect(p.locator('dialog[open]')).toHaveCount(0);
});

test('other browsers are not shown the Safari note', async ({ app: p, browserName }) => {
  test.skip(browserName === 'webkit', 'not Safari');
  await p.locator('dialog[open]').getByRole('button', { name: 'Get started' }).click();
  await p.waitForTimeout(500);
  await expect(p.locator('dialog[open]')).toHaveCount(0);
});
