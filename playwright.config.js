/**
 * Playwright Configuration for CodeDB E2E Tests
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/playwright',
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    video: 'off',
    screenshot: 'only-on-failure',
  },
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-reports/playwright-results.json' }]
  ],
});
