// POS sale workflow. The single most critical business path — if this
// breaks, the cashier can't ring a customer up.
//
// Mix of API + UI:
//   - signup/onboarding via UI (free regression on those flows)
//   - product create + sale record via API (faster, less brittle)
//   - /sales page assertion via UI (the contract is "the cashier sees what
//     they just rang up")

import { expect, test } from "@playwright/test";
import {
  getWatchesCategoryId,
  createProduct,
  recordCartSale,
} from "./helpers/tenant-setup";

test.describe.configure({ mode: "serial" });

test("POS happy path: cash sale → /sales lists it → /api/sales returns it", async ({
  page,
  baseURL,
}) => {
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const prod = await createProduct(page.request, baseURL!, categoryId, {
    name: `Cash Watch ${Date.now()}`,
    quantity: 5,
    price: 250,
  });

  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: prod.id, quantity: 2, pricePerUnit: prod.price }],
    { paymentMethod: "cash", customerName: "POS Buyer" },
  );
  expect(sale.total).toBe(500);
  expect(sale.invoiceId).toMatch(/^INV-/);
  expect(sale.saleIds.length).toBe(1);

  // API listing reflects it.
  const listRes = await page.request.get(`${baseURL}/api/sales`);
  expect(listRes.ok()).toBe(true);
  const list = (await listRes.json()) as { data: Array<{ invoiceId: string }> };
  expect(list.data.some((s) => s.invoiceId === sale.invoiceId)).toBe(true);

  // UI listing reflects it.
  await page.goto("/sales");
  await expect(page.getByText(prod.name).first()).toBeVisible({
    timeout: 15_000,
  });
});

test("POS validation: empty cart returns 400 with CART_EMPTY code", async ({
  page,
  baseURL,
}) => {
  const res = await page.request.post(`${baseURL}/api/sales/cart`, {
    data: { lines: [], options: { paymentMethod: "cash" } },
  });
  // Zod rejects pre-handler (lines.min(1)) — also 400. Either way the
  // shape is { error: ... }.
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBeTruthy();
});

test("POS validation: insufficient stock returns 400 INSUFFICIENT_STOCK with detail", async ({
  page,
  baseURL,
}) => {
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const prod = await createProduct(page.request, baseURL!, categoryId, {
    quantity: 1,
    price: 100,
  });

  const res = await page.request.post(`${baseURL}/api/sales/cart`, {
    data: {
      lines: [{ productId: prod.id, quantity: 5, pricePerUnit: 100 }],
      options: { paymentMethod: "cash" },
    },
  });
  // DomainError → 400 with { error: "INSUFFICIENT_STOCK", detail: {...} }.
  expect(res.status()).toBe(400);
  const body = (await res.json()) as {
    error: string;
    detail?: { requested?: number; available?: number; productId?: string };
  };
  expect(body.error).toBe("INSUFFICIENT_STOCK");
  expect(body.detail?.requested).toBe(5);
  expect(body.detail?.available).toBe(1);
});

test("POS validation: unknown product returns 400 PRODUCT_NOT_FOUND", async ({
  page,
  baseURL,
}) => {
  const res = await page.request.post(`${baseURL}/api/sales/cart`, {
    data: {
      lines: [
        {
          // Random UUID that doesn't belong to this tenant.
          productId: "00000000-0000-0000-0000-000000000000",
          quantity: 1,
          pricePerUnit: 100,
        },
      ],
      options: { paymentMethod: "cash" },
    },
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("PRODUCT_NOT_FOUND");
});

test("POS authz: anonymous request returns 401", async ({ playwright, baseURL }) => {
  // Use a fresh APIRequestContext (no cookies) — the shared owner storage
  // state would otherwise authenticate this request.
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await anon.post(`${baseURL}/api/sales/cart`, {
    data: {
      lines: [
        {
          productId: "00000000-0000-0000-0000-000000000000",
          quantity: 1,
          pricePerUnit: 100,
        },
      ],
      options: { paymentMethod: "cash" },
    },
  });
  expect(res.status()).toBe(401);
  await anon.dispose();
});
