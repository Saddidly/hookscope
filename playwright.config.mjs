import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4179',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined },
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: "npm start",
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
    timeout: 180_000,
    env: { HOOKSCOPE_PORT: '4179', HOOKSCOPE_DATA_DIR: path.resolve('.playwright-data', randomUUID()) },
  },
});
