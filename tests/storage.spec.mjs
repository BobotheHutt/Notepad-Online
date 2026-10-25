import fs from 'node:fs';
import { test, expect, openFile, fixture, saveNow } from './helpers.mjs';

const dbState = (p, id) => p.evaluate(async (id) => {
  const db = await new Promise((r) => { const q = indexedDB.open('notepad-online'); q.onsuccess = () => r(q.result); });
  const get = (s, k) => new Promise((r) => { const q = db.transaction(s).objectStore(s).get(k); q.onsuccess = () => r(q.result); });
  const all = (s) => new Promise((r) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => r(q.result); });
  const rec = id && (await get('docs', id));
  const out = {
    version: db.version, docs: (await all('docs')).length, sources: (await all('sources')).map((s) => s.length),
    recHasSources: !!(rec && rec.sources), items: rec && rec.items.length
  };
  db.close();
  return out;
}, id);

test('a PDF saved the old way (file inside the record) still opens, and moves its file out', async ({ page: p, errors }) => {
  await p.goto('/icon.svg');
  const bytes = [...fs.readFileSync(fixture('letter.pdf'))];
  await p.evaluate(async (bytes) => {
    const db = await new Promise((r) => {
      const q = indexedDB.open('notepad-online', 1);
      q.onupgradeneeded = () => { q.result.createObjectStore('docs', { keyPath: 'id' }); q.result.createObjectStore('versions', { keyPath: 'vid', autoIncrement: true }).createIndex('docId', 'docId'); };
      q.onsuccess = () => r(q.result);
    });
    const tx = db.transaction('docs', 'readwrite');
    tx.objectStore('docs').put({ id: 'legacy1', type: 'pdf', title: 'Legacy', titleAuto: false, created: 1, updated: Date.now(), sources: [new Uint8Array(bytes).buffer], pages: [], items: [], fields: {}, text: '', settings: {} });
    await new Promise((r) => (tx.oncomplete = r));
    db.close();
  }, bytes);
  await p.goto('/'); await p.waitForSelector('body.ready'); await p.waitForSelector('.pdf-page canvas');
  await expect(p.locator('.pdf-page')).toHaveCount(2);
  const bb = await p.locator('.pdf-page').first().boundingBox();
  await p.click('[data-pdf-tool="box"]');
  await p.mouse.move(bb.x + 100, bb.y + 300); await p.mouse.down(); await p.mouse.move(bb.x + 200, bb.y + 360, { steps: 2 }); await p.mouse.up();
  await p.keyboard.press('Escape');
  await saveNow(p);
  expect(await dbState(p, 'legacy1')).toEqual({ version: 3, docs: 1, sources: [1], recHasSources: false, items: 1 });
  await p.reload(); await p.waitForSelector('body.ready'); await p.waitForSelector('.pdf-page canvas');
  await expect(p.locator('.pdf-box')).toHaveCount(1);
  // the backup still carries the PDF itself
  const [dl] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => document.querySelector('[data-action="backup"]').click())]);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  const entry = backup.docs.find((d) => d.id === 'legacy1');
  expect(Buffer.from(entry.sources[0], 'base64').equals(fs.readFileSync(fixture('letter.pdf')))).toBe(true);
});

test('adding another PDF, duplicating, deleting', async ({ app: p }) => {
  await openFile(p, 'letter.pdf');
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.evaluate(() => document.querySelector('[data-action="pdf-add"]').click())]);
  await fc.setFiles(fixture('form.pdf'));
  await expect(p.locator('.pdf-page')).toHaveCount(3);
  await saveNow(p);
  expect((await dbState(p)).sources).toEqual([2]);
  await p.evaluate(() => document.querySelector('[data-action="duplicate"]').click());
  await expect.poll(async () => (await dbState(p)).sources).toEqual([2, 2]);
  await p.reload(); await p.waitForSelector('body.ready'); await p.waitForSelector('.pdf-page canvas');
  await expect(p.locator('.pdf-page')).toHaveCount(3);
  await p.locator('.doc-item.active .doc-del').click({ force: true });
  await p.locator('dialog[open]').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await dbState(p)).sources).toEqual([2]);
});
