import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
export default defineConfig({
  testDir: './test/ui',
  timeout: 30_000,
  workers: 1,
  use: {
    headless: true,
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
