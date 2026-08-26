import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const API_PORT = 4000;

export default defineConfig({
  testDir: "./e2e",
  // Every spec authenticates as the same two fixed seeded accounts (see e2e/auth.setup.ts),
  // not per-test users — running specs concurrently lets them race over that shared
  // curator/student state (e.g. one spec's course-progress mutation corrupting another's
  // in-flight moduleId). Serialize to one worker instead of parallelizing across specs.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
  webServer: [
    {
      command: "npm run api:dev",
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "npm run dev",
      port: PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
