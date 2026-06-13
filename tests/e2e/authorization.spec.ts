// Permission-restricted route workflow. Covers two distinct guard layers:
//   1. Pre-auth (anonymous) — every /api/* tenant route returns 401.
//   2. Permission-restricted — owner / staff can/can't read certain things.
//
// Anonymous tests mint their own `playwright.request.newContext({ storageState: { cookies: [], origins: [] } })` so they
// bypass the shared-owner storage state loaded at the project level.

import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("authz: every tenant /api/* route returns 401 to anonymous", async ({
  playwright,
  baseURL,
}) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const probes = [
    "/api/products",
    "/api/sales",
    "/api/expenses",
    "/api/customers/by-phone/%2B201001234567",
    "/api/insights/overview",
    "/api/team",
    "/api/returns",
    "/api/branches",
  ];
  for (const path of probes) {
    const res = await anon.get(`${baseURL}${path}`);
    // 401 expected. 200 is a bug; 403/404/307/308 acceptable for surfaces
    // that consider their existence sensitive.
    expect(
      [401, 403, 404, 307, 308].includes(res.status()),
      `unexpected status ${res.status()} for ${path}`,
    ).toBe(true);
  }
  await anon.dispose();
});

test("authz: /api/admin/* is hard-404 for non-admin (incl. anonymous)", async ({
  playwright,
  baseURL,
}) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const probes = ["/api/admin/overview", "/api/admin/tenants"];
  for (const path of probes) {
    const res = await anon.get(`${baseURL}${path}`);
    expect([401, 404].includes(res.status())).toBe(true);
  }
  await anon.dispose();
});

test("authz: tenant owner reads their own /api/insights/overview", async ({
  page,
  baseURL,
}) => {
  const res = await page.request.get(`${baseURL}/api/insights/overview`);
  // Shared-owner state has view_insights implicitly; should succeed.
  expect(res.status()).toBe(200);
});

test("authz: rate-limit guards do not block a single allowed read (smoke)", async ({
  page,
  baseURL,
}) => {
  // One request must succeed — confirms our default bucket sizes don't
  // accidentally lock the cashier out. The 429 path is exercised at the
  // unit-test level on lib/api/tenant-rate-limit.ts.
  const res = await page.request.get(`${baseURL}/api/branches`);
  expect(res.status()).toBe(200);
});
