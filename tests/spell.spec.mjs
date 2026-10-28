// Spelling checked by Noteshack itself, in the document's language.
import { test, expect } from './helpers.mjs';

const flagged = (p) => p.evaluate(() => {
  const h = CSS.highlights.get('np-spell');
  return h ? [...h].map((r) => r.toString()).sort() : [];
});
// right-click the first underlined word
async function rightClickFlagged(p, word) {
  const box = await p.evaluate((w) => {
    const r = [...CSS.highlights.get('np-spell')].find((x) => x.toString() === w).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, word);
  await p.mouse.click(box.x, box.y, { button: 'right' });
}

test('Spanish misspellings are underlined and corrected from the menu', async ({ app: p }) => {
  await p.click('#editor');
  await p.keyboard.type('La reunión del consejo se celebrrará el próximo martes en la sala principall del ayuntamiento. ');
  await expect(p.locator('#sb-lang')).toHaveText('Spanish', { timeout: 15000 });
  await expect.poll(() => flagged(p), { timeout: 15000 }).toEqual(['celebrrará', 'principall']);
  await rightClickFlagged(p, 'celebrrará');
  const menu = p.locator('.spell-menu');
  await expect(menu.getByRole('menuitem', { name: 'celebrará', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'celebrará', exact: true }).click();
  await expect(p.locator('#editor')).toContainText('se celebrará el próximo');
  await expect.poll(() => flagged(p)).toEqual(['principall']);
  // undo brings the old word back
  await p.keyboard.press('Control+z');
  await expect(p.locator('#editor')).toContainText('se celebrrará el');
});

test('add to the dictionary (kept), or ignore in this document', async ({ app: p }) => {
  await p.click('#editor');
  await p.keyboard.type('Our team at Noteshackery reviewed the quarterly plan with Zorblax yesterday afternoon. ');
  await expect.poll(() => flagged(p), { timeout: 15000 }).toEqual(['Noteshackery', 'Zorblax']);
  await rightClickFlagged(p, 'Noteshackery');
  await p.locator('.spell-menu').getByRole('menuitem', { name: /Add “Noteshackery”/ }).click();
  await expect.poll(() => flagged(p)).toEqual(['Zorblax']);
  await rightClickFlagged(p, 'Zorblax');
  await p.locator('.spell-menu').getByRole('menuitem', { name: 'Ignore it in this document' }).click();
  await expect.poll(() => flagged(p)).toEqual([]);
  // a new document: the added word stays known, the ignored one does not
  await p.click('.sb-head [data-action="new"]');
  await expect(p.locator('.doc-item')).toHaveCount(2);
  await expect(p.locator('#editor')).toHaveText('');
  await p.click('#editor');
  await p.keyboard.type('Noteshackery and Zorblax met again for another long discussion about the plan. ');
  await expect.poll(() => flagged(p), { timeout: 15000 }).toEqual(['Zorblax']);
});

test('shift + right-click keeps the browser menu; spell check off clears the underlines', async ({ app: p }) => {
  await p.click('#editor');
  await p.keyboard.type('This sentense has one mistake in it, which should be found by the checker. ');
  await expect.poll(() => flagged(p), { timeout: 15000 }).toEqual(['sentense']);
  await p.keyboard.down('Shift');
  await rightClickFlagged(p, 'sentense');
  await p.keyboard.up('Shift');
  await expect(p.locator('.spell-menu')).toHaveCount(0);
  await p.keyboard.press('Escape');
  await p.evaluate(() => { const b = document.querySelector('[data-action="spellcheck"]'); if (b) b.click(); });
  await expect.poll(() => flagged(p)).toEqual([]);
});
