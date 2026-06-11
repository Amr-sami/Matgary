// Cash-shift workflow. The cashier opens a shift at the start of the day,
// rings up sales, and closes it. The close step takes a counted-cash value
// and the difference is the "variance".
//
// Cash reconciliation is opt-in per branch — these tests turn it on via
// /api/settings/cash-drawer first, then exercise the open + close flow.

import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function getActiveBranchId(
  page: import("@playwright/test").Page,
  baseURL: string,
): Promise<string> {
  const res = await page.request.get(`${baseURL}/api/branches`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    branches: Array<{ id: string; isPrimary?: boolean }>;
    currentBranchId?: string;
  };
  return (
    body.currentBranchId ??
    body.branches.find((b) => b.isPrimary)?.id ??
    body.branches[0]!.id
  );
}

async function enableCashReconciliation(
  page: import("@playwright/test").Page,
  baseURL: string,
  branchId: string,
): Promise<void> {
  const res = await page.request.patch(
    `${baseURL}/api/settings/cash-drawer?branchId=${encodeURIComponent(branchId)}`,
    { data: { cashReconciliationEnabled: true } },
  );
  expect(res.status(), await res.text()).toBeLessThan(300);
}

test("shift happy path: open → current → close", async ({ page, baseURL }) => {
  const branchId = await getActiveBranchId(page, baseURL!);
  await enableCashReconciliation(page, baseURL!, branchId);

  // Open a shift with 500 EGP starting float.
  const open = await page.request.post(`${baseURL}/api/cash-shifts`, {
    data: { openingFloat: 500, branchId },
  });
  expect(open.status(), await open.text()).toBeLessThan(300);
  const opened = (await open.json()) as { shift: { id: string } };
  expect(opened.shift?.id).toBeTruthy();

  // /current should now return the shift.
  const current = await page.request.get(
    `${baseURL}/api/cash-shifts/current?branchId=${encodeURIComponent(branchId)}`,
  );
  expect(current.ok()).toBe(true);
  const cur = (await current.json()) as { shift?: { id: string } };
  expect(cur.shift?.id).toBe(opened.shift.id);

  // Close. A closingNote is required when expected_cash differs from
  // counted_cash — pass one defensively so the test is robust to shared
  // shop state (the shared-owner tenant accumulates cash totals across
  // runs).
  const close = await page.request.post(
    `${baseURL}/api/cash-shifts/${opened.shift.id}/close`,
    { data: { countedCash: 500, closingNote: "test close" } },
  );
  expect(close.status(), await close.text()).toBeLessThan(300);
});

test("shift behaviour: owners with cash_reconciliation can open repeatedly (auto-managed)", async ({
  page,
  baseURL,
}) => {
  // Pins documented owner-desk behaviour: an owner with
  // manage_cash_reconciliation can re-open a shift even when one is open;
  // the prior shift is treated as the owner-desk auto-close. For STAFF
  // users this should 409 — that variant lives in the unit test for
  // openShift (lib/repo/cash-shifts.ts) where we can mint a staff role
  // without a full e2e dance.
  const branchId = await getActiveBranchId(page, baseURL!);
  await enableCashReconciliation(page, baseURL!, branchId);

  const first = await page.request.post(`${baseURL}/api/cash-shifts`, {
    data: { openingFloat: 100, branchId },
  });
  expect(first.ok()).toBe(true);

  const second = await page.request.post(`${baseURL}/api/cash-shifts`, {
    data: { openingFloat: 100, branchId },
  });
  // Owner: succeeds.
  expect(second.status()).toBe(201);
});

test("shift authz: anonymous open returns 401", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await anon.post(`${baseURL}/api/cash-shifts`, {
    data: { openingFloat: 100 },
  });
  expect(res.status()).toBe(401);
  await anon.dispose();
});
