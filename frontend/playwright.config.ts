import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:5178", headless: true },
  webServer: {
    command: "npm run dev -- --port 5178",
    url: "http://127.0.0.1:5178",
    reuseExistingServer: false,
  },
  reporter: "list",
});
