import { accessSync, constants } from "node:fs";
import { defineConfig } from "@playwright/test";

const systemBrowser = ["/usr/bin/chromium", "/usr/bin/google-chrome"].find((file) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

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
