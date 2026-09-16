// Sale-return workflow. Returns are tied to a specific sale row (not an
// invoice), and a partial-quantity return is the common case.

import { expect, test } from "@playwright/test";
import {
  getWatchesCategoryId,
  createProduct,
  recordCartSale,
} from "./helpers/tenant-setup";

test.describe.configure({ mode: "serial" });

test("return happy path: full return of 2 units restores stock", async ({
  page,
  baseURL,
}) => {
  const catId = await getWatchesCategoryId(page.request, baseURL!);
  const p = await createProduct(page.request, baseURL!, catId, {
    quantity: 10,
    price: 80,
  });

  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: p.id, quantity: 2, pricePerUnit: 80 }],
    { paymentMethod: "cash" },
  );

  // Pull the sale row id (the return endpoint takes saleId not invoiceId).
  const listRes = await page.request.get(`${baseURL}/api/sales`);
  const { data } = (await listRes.json()) as {
    data: Array<{ id: string; productId: string; invoiceId: string }>;
  };
  const row = data.find((s) => s.invoiceId === sale.invoiceId)!;
  expect(row).toBeTruthy();

  const ret = await page.request.post(`${baseURL}/api/returns`, {
    data: {
      saleId: row.id,
      productId: p.id,
      returnedQuantity: 2,
      reason: "Customer didn't like it",
    },
  });
  expect(ret.status(), await ret.text()).toBeLessThan(300);

  // Stock should be back to 10 (started 10, sold 2, returned 2 = 10).
  const prods = await page.request.get(`${baseURL}/api/products`);
  const { data: rows } = (await prods.json()) as {
    data: Array<{ id: string; quantity: number }>;
  };
  const after = rows.find((r) => r.id === p.id);
  expect(after?.quantity).toBe(10);
});

test("return behaviour: over-return is accepted today (pinned: latent bug — recordReturn does not validate qty vs sold)", async ({
  page,
  baseURL,
}) => {
  // This test PINS CURRENT behaviour, not desired behaviour. The
  // recordReturn repo function credits whatever returnedQuantity the
  // caller sends, with `allowNegative: true` on the stock adjust. A
  // future fix that adds qty-vs-sold validation should update this test
  // to assert 400 + a new DomainError code (RETURN_OVER_QTY).
  const catId = await getWatchesCategoryId(page.request, baseURL!);
  const p = await createProduct(page.request, baseURL!, catId, {
    quantity: 5,
    price: 100,
  });

  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: p.id, quantity: 1, pricePerUnit: 100 }],
    { paymentMethod: "cash" },
  );
  const listRes = await page.request.get(`${baseURL}/api/sales`);
  const { data } = (await listRes.json()) as {
    data: Array<{ id: string; invoiceId: string }>;
  };
  const saleId = data.find((s) => s.invoiceId === sale.invoiceId)!.id;

  const ret = await page.request.post(`${baseURL}/api/returns`, {
    data: {
      saleId,
      productId: p.id,
      returnedQuantity: 99,
      reason: "Over-return attempt",
    },
  });
  // Pin: currently 201 (accepted). A refactor that adds validation will
  // legitimately break this test — update it then.
  expect(ret.status()).toBe(201);
});

test("return authz: anonymous returns 401", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await anon.post(`${baseURL}/api/returns`, {
    data: {
      saleId: "00000000-0000-0000-0000-000000000000",
      productId: "00000000-0000-0000-0000-000000000000",
      returnedQuantity: 1,
      reason: "x",
    },
  });
  expect(res.status()).toBe(401);
  await anon.dispose();
});
