// Authentication-flow workflow. Complements auth-smoke.spec.ts (endpoint-
// level checks) with full credentials-login round-trips.
//
// Covers:
//   - login → dashboard happy path
//   - wrong password rejected (stays on login)
//   - logout clears the session
//
// We use DB-direct provisioning (ensureOwner) rather than the signup UI to
// keep the suite fast under dev compile. The smoke.spec.ts spec covers
// the signup → onboarding regression independently.

import { expect, test } from "@playwright/test";
import dotenv from "dotenv";
import path from "node:path";
import { ensureOwner } from "./helpers/seed-owner";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

test.describe.configure({ mode: "serial" });

// Auth flow tests must start anonymous — the project-level shared owner
// storage state would otherwise pre-authenticate them.
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_OWNER = {
  email: "auth-flow@matgary.test",
  password: "AuthFlowPass123!",
  handle: "auth-flow-tenant",
  shopName: "Auth Flow Shop",
} as const;

test.beforeAll(async () => {
  // Idempotent — reuses the row if it already exists.
  await ensureOwner(TEST_OWNER);
});

test("login happy path: known credentials reach the dashboard", async ({
  page,
}) => {
  await page.goto("/ar/login");
  await page.locator('input[name="email"]').fill(TEST_OWNER.email);
  await page.locator('input[name="password"]').fill(TEST_OWNER.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 });
  expect(new URL(page.url()).pathname).toBe("/");
});

test("login rejection: wrong password stays on login", async ({ page }) => {
  await page.goto("/ar/login");
  await page.locator('input[name="email"]').fill(TEST_OWNER.email);
  await page.locator('input[name="password"]').fill("WrongPassword!");
  await page.locator('button[type="submit"]').click();
  // Don't navigate to /. Give the credentials POST a moment to complete.
  await page.waitForTimeout(3_000);
  expect(new URL(page.url()).pathname).not.toBe("/");
});

test("logout clears the session: protected route bounces back to login", async ({
  page,
  baseURL,
}) => {
  // First log in.
  await page.goto("/ar/login");
  await page.locator('input[name="email"]').fill(TEST_OWNER.email);
  await page.locator('input[name="password"]').fill(TEST_OWNER.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 });

  // Authenticated: /api/branches returns 200.
  const before = await page.request.get(`${baseURL}/api/branches`);
  expect(before.status()).toBe(200);

  // Clear all cookies — this is the most reliable "log out" for an
  // assertion that the server enforces the session boundary.
  await page.context().clearCookies();

  const after = await page.request.get(`${baseURL}/api/branches`);
  expect(after.status()).toBe(401);
});
