import { defineConfig, devices } from "@playwright/test";

// Runs the production build against a dedicated port (3100) so it never
// collides with a developer's running `next dev` (defaults 3000/3001) or the
// docker compose `matgary-app` service on 3000. `webServer` builds once per
// run and reuses an existing server when invoked locally — CI always starts
// from scratch.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "ar-EG",
    timezoneId: "Africa/Cairo",
  },
  // Setting PLAYWRIGHT_NO_WEBSERVER=1 + PLAYWRIGHT_BASE_URL=http://localhost:3001
  // points the test suite at an already-running dev server — handy for fast
  // local iteration. In CI we always build + start fresh.
  webServer:
    process.env.PLAYWRIGHT_NO_WEBSERVER === "1"
      ? undefined
      : {
          command:
            process.env.PLAYWRIGHT_NO_BUILD === "1"
              ? "npx next start -p 3100"
              : "npm run build && npx next start -p 3100",
          url: "http://localhost:3100/healthz",
          timeout: 240_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
