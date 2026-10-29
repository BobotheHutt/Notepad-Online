// Tools → Report a problem: sent to Noteshack's service, which files it on
// GitHub; the text is kept if it could not be sent.
import { test, expect } from './helpers.mjs';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };

test('a problem report is sent with the version, browser and language, and nothing else', async ({ app: p, errors }) => {
  const sent = [];
  let status = 503;
  await p.route('https://api.noteshack.org/report', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status, headers: Object.assign({ 'content-type': 'application/json' }, CORS), body: status === 200 ? '{"url":"https://github.com/BobotheHutt/Noteshack/issues/7"}' : '{"error":"failed"}' });
  });
  await p.click('#editor');
  await p.keyboard.type('A private letter that must not be sent.');
  await p.click('.menu-btn:has-text("Tools")');
  await p.click('[data-action="report"]');
  const dlg = p.locator('dialog[open]');
  await expect(dlg).toContainText('posted publicly');
  await expect(dlg).toContainText(/Also sent: Noteshack 2026\.\d+\.\d+-\d+, \w+/);
  // too little to go on
  await dlg.getByLabel('What went wrong?').fill('broken');
  await dlg.getByRole('button', { name: 'Send' }).click();
  await expect(p.locator('dialog[open]')).toContainText('Say a little more');
  expect(sent).toEqual([]);
  // the service failing: the text is still there to send again
  await p.locator('dialog[open]').getByLabel('What went wrong?').fill('The page number box does not take two digits.');
  await p.locator('dialog[open]').getByLabel(/What were you doing/).fill('Typing 12 into it.');
  await p.locator('dialog[open]').getByRole('button', { name: 'Send' }).click();
  await expect(p.locator('dialog[open]')).toContainText('could not be sent (503)');
  await expect(p.locator('dialog[open]').getByLabel('What went wrong?')).toHaveValue('The page number box does not take two digits.');
  status = 200;
  await p.locator('dialog[open]').getByRole('button', { name: 'Send' }).click();
  await expect(p.locator('dialog[open]')).toContainText('Your report was sent.');
  await expect(p.locator('dialog[open] a')).toHaveAttribute('href', 'https://github.com/BobotheHutt/Noteshack/issues/7');
  expect(sent.length).toBe(2);
  const last = sent[1];
  expect(Object.keys(last).sort()).toEqual(['browser', 'lang', 'steps', 'version', 'website', 'what']);
  expect(last).toMatchObject({ what: 'The page number box does not take two digits.', steps: 'Typing 12 into it.', lang: 'en', website: '' });
  expect(JSON.stringify(sent)).not.toContain('private letter');
  // the refusal this test made
  errors.splice(0, errors.length, ...errors.filter((e) => !/503/.test(e)));
});
