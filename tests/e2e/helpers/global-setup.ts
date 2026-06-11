// Global setup: provision ONE owner tenant via direct DB writes (skipping
// the brittle signup UI under dev compile), then drive the login form to
// get authenticated cookies, save state to disk.
//
// Specs load that state via `storageState` so they skip the slow
// signup-onboarding browser dance entirely. The auth-flow specs (smoke +
// auth-smoke + authentication) opt out via `test.use({ storageState: ... empty })`
// and exercise signup/login themselves.

import { chromium, expect, type FullConfig } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { ensureOwner } from "./seed-owner";

// Make DATABASE_URL etc available even when Playwright was launched without
// an explicit env load.
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export const SHARED_STATE_PATH = path.resolve(
  process.cwd(),
  "tests/e2e/.auth/shared-owner.json",
);

// Stable identity for the shared owner. We always reuse this user across
// runs — `ensureOwner` is idempotent and returns the existing rows if a
// previous run created them.
export const SHARED_OWNER = {
  email: "shared-owner@matgary.test",
  password: "SharedPass123!",
  handle: "shared-owner-tenant",
  shopName: "Shared Test Shop",
} as const;

async function loginAndSaveState(baseURL: string): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL,
    locale: "ar-EG",
    timezoneId: "Africa/Cairo",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  page.setDefaultNavigationTimeout(45_000);

  await page.goto("/ar/login");
  await page.locator('input[name="email"]').fill(SHARED_OWNER.email);
  await page.locator('input[name="password"]').fill(SHARED_OWNER.password);
  await page.locator('button[type="submit"]').click();

  // Auth.js redirects to `/` on success; dev mode can take a while to
  // compile that route on first hit.
  await page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 });

  // Sanity: an authenticated /api/branches call succeeds.
  const probe = await context.request.get(`${baseURL}/api/branches`);
  expect(probe.ok()).toBe(true);

  await context.storageState({ path: SHARED_STATE_PATH });
  await browser.close();
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  await fs.mkdir(path.dirname(SHARED_STATE_PATH), { recursive: true });

  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ?? config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("[e2e setup] no baseURL");

  // Reuse a stored state if it's recent — dev-mode global-setup is slow.
  if (!process.env.CI) {
    try {
      const stat = await fs.stat(SHARED_STATE_PATH);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 30 * 60 * 1000) {
        // eslint-disable-next-line no-console
        console.log(
          `[e2e setup] reusing shared state (age ${Math.round(ageMs / 1000)}s)`,
        );
        return;
      }
    } catch {
      /* fall through */
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[e2e setup] provisioning shared owner (DB direct) ${SHARED_OWNER.email}`,
  );
  await ensureOwner(SHARED_OWNER);
  // eslint-disable-next-line no-console
  console.log(`[e2e setup] logging in to capture session cookies`);
  await loginAndSaveState(baseURL);
  // eslint-disable-next-line no-console
  console.log(`[e2e setup] state saved → ${SHARED_STATE_PATH}`);
}
