// Tests for Noteshack: `npm test`. They serve the repository as the site
// (tests/server.mjs) and drive it in Chromium. The PDFs they open are made
// fresh by tests/global-setup.mjs, so nothing personal is ever committed.
import { defineConfig } from '@playwright/test';

const PORT = 8790;

export default defineConfig({
  testDir: 'tests',
  globalSetup: './tests/global-setup.mjs',
  // reading scans is slow on a small machine
  timeout: 5 * 60 * 1000,
  expect: { timeout: 15000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1400, height: 1000 },
    acceptDownloads: true,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `node tests/server.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI
  }
});
