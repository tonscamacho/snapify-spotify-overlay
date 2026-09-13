import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "verify/web",
  timeout: 60000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "verify/web/playwright-report" }]],
  outputDir: "verify/web/test-results",
  use: {
    baseURL: "http://localhost:1420",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420/",
    reuseExistingServer: true,
    timeout: 90000,
  },
});
