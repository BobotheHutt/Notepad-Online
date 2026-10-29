// A release: each of the app's own files is loaded as file?v=N, N being the
// release in sw.js, so no cache on the way (Cloudflare's, the browser's) can
// serve new pages with old code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test.skip(({ browserName }) => browserName !== 'chromium', 'no browser needed: once is enough');

test('every file the page loads carries the release number', () => {
  const release = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/const CACHE = 'noteshack-v(\d+)'/)[1];
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const own = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
  expect(own.length).toBeGreaterThan(15);
  expect(own.filter((u) => !u.endsWith('?v=' + release)), 'files without ?v=' + release).toEqual([]);
});
