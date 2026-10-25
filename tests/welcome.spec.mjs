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
