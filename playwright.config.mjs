import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.mjs",
  timeout: 30_000,
  workers: 1, // one Chromium profile with the extension at a time
  reporter: "list",
});
