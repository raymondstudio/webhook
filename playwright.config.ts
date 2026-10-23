import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const systemBrowser = ["/usr/bin/chromium", "/usr/bin/google-chrome"].find((file) =>
  existsSync(file),
);

export default defineConfig({
  testDir: "./test/ui",
  timeout: 30_000,
  workers: 1,
  use: {
    headless: true,
    launchOptions: systemBrowser ? { executablePath: systemBrowser } : {},
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
