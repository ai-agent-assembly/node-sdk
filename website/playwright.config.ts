import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL || "http://127.0.0.1:3083";
export default defineConfig({
  testDir: "./tests",
  timeout: 90000,
  workers: 1,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } }
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "pnpm serve --host 127.0.0.1 --port 3083 --no-open",
        url: `${baseURL}/node-sdk/`,
        reuseExistingServer: !process.env.CI
      }
});
