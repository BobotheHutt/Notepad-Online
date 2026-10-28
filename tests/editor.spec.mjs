import { test, expect, saveAsType } from './helpers.mjs';

test('writing with Markdown shortcuts, tables and undo', async ({ app: p }) => {
  await p.click('#editor');
  await p.keyboard.type('# My Heading'); await p.keyboard.press('Enter');
  await p.keyboard.type('Hello world, this is a test.'); await p.keyboard.press('Enter');
  await p.keyboard.type('- first'); await p.keyboard.press('Enter'); await p.keyboard.type('second');
  await p.keyboard.press('Enter'); await p.keyboard.press('Enter');
  await p.keyboard.type('[ ] task one'); await p.keyboard.press('Enter'); await p.keyboard.type('task two');
  await p.keyboard.press('Enter'); await p.keyboard.press('Enter');
  await p.keyboard.type('after ');
  await p.keyboard.press('Control+b'); await p.keyboard.type('bold'); await p.keyboard.press('Control+b');
  const ed = p.locator('#editor');
  await expect(ed.locator('h1')).toHaveText('My Heading');
  await expect(ed.locator('ul:not(.checklist) > li')).toHaveCount(2);
  await expect(ed.locator('ul.checklist > li')).toHaveCount(2);
  expect(await p.evaluate(() => {
    const w = document.evaluate("//*[@id='editor']//*[text()='bold']", document, null, 9, null).singleNodeValue;
    return w && +getComputedStyle(w).fontWeight;
  })).toBeGreaterThanOrEqual(600);
  await expect(p.locator('#doc-title')).toHaveValue('My Heading');

  await p.keyboard.press('Control+End'); await p.keyboard.press('Enter');
  await p.click('#toolbar [data-action="table-menu"]');
  await p.click('.grid-cell[data-r="3"][data-c="3"]');
  await p.keyboard.type('H1'); await p.keyboard.press('Tab'); await p.keyboard.type('H2');
  await p.click('#ctxbar [aria-label="Insert row below"]');
  await expect(ed.locator('table tr')).toHaveCount(4);
  await p.keyboard.press('Control+z');
  await expect(ed.locator('table tr')).toHaveCount(3);
});

test('find and replace touches the text, not the markup', async ({ app: p }) => {
  await p.click('#editor');
  await p.keyboard.type('task one, task two, and a table');
  await p.keyboard.press('Control+h');
  await p.fill('#find-q', 'task');
  await expect(p.locator('#find-count')).toContainText('of 2');
  await p.fill('#find-r', 'job');
  await p.click('[data-action="replace-all"]');
  await expect(p.locator('#editor')).toHaveText('job one, job two, and a table');
});

test('saving, reloading, exporting and a second document', async ({ app: p }) => {
  await p.click('#editor');
  await p.keyboard.type('# Kept'); await p.keyboard.press('Enter'); await p.keyboard.type('This survives a reload.');
  await expect(p.locator('#save-status')).toHaveText('Saved in Noteshack', { timeout: 10000 });
  await p.reload(); await p.waitForSelector('body.ready');
  await expect(p.locator('#editor')).toContainText('This survives a reload.');
  for (const kind of ['docx', 'md', 'html', 'txt']) {
    const dl = await saveAsType(p, kind);
    expect(dl.suggestedFilename()).toBe('Kept.' + kind);
    if (kind === 'docx') await dl.saveAs(test.info().outputPath('Kept copy.docx'));
  }
  // the Word file opens again as a document of its own
  await p.setInputFiles('#file-open', test.info().outputPath('Kept copy.docx'));
  // its own entry in the list (the original shows the same heading, so that alone proves nothing)
  await expect(p.locator('.doc-item')).toHaveCount(2);
  await expect(p.locator('#doc-title')).toHaveValue('Kept copy');
  await expect(p.locator('#editor h1')).toHaveText('Kept');
  await expect(p.locator('#editor')).toContainText('This survives a reload.');
  await p.click('.sb-head [data-action="new"]');
  await p.keyboard.type('Second doc');
  await expect(p.locator('.doc-item')).toHaveCount(3, { timeout: 10000 });
});

const DIRTY = '<p>Pasted <b>bold</b> <img src=x onerror="window.pwned=1"> <a href="javascript:window.pwned=3">bad</a> <span style="color:#ff0000">red</span></p><script>window.pwned=2</script>';

test('pasted HTML is cleaned', async ({ app: p, browserName }) => {
  // the cleaner itself, in every browser (each parses HTML its own way)
  const clean = await p.evaluate((h) => NpSanitize.html(h), DIRTY);
  expect(clean).toContain('<b>bold</b>');
  expect(clean).not.toMatch(/onerror|javascript:|<script/i);
  // a paste, where a test can make one (Firefox and Safari ignore a made-up clipboard)
  if (browserName === 'chromium') {
    await p.click('#editor');
    await p.evaluate((h) => {
      const dt = new DataTransfer();
      dt.setData('text/html', h);
      dt.setData('text/plain', 'Pasted bold bad red');
      document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, DIRTY);
    await p.waitForTimeout(500);
    const html = await p.locator('#editor').innerHTML();
    expect(html).toContain('<b>bold</b>');
    expect(html).not.toMatch(/onerror|javascript:|<script/i);
  }
  await p.waitForTimeout(300);
  expect(await p.evaluate(() => window.pwned)).toBeUndefined();
});
