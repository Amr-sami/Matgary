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

test("return cap: a return past the quantity sold is refused with RETURN_EXCEEDS_SOLD", async ({
  page,
  baseURL,
}) => {
  // Doc 14 R25. recordReturn (lib/repo/operations.ts) caps a return at
  // quantitySold − quantity already returned for that sale line and answers
  // 400 RETURN_EXCEEDS_SOLD; the stock must not move on a refused return.
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
  expect(ret.status(), await ret.text()).toBe(400);
  expect(((await ret.json()) as { error: string }).error).toBe("RETURN_EXCEEDS_SOLD");

  // Nothing credited: 5 in stock, 1 sold, refused return leaves 4.
  const prods = await page.request.get(`${baseURL}/api/products`);
  const { data: rows } = (await prods.json()) as {
    data: Array<{ id: string; quantity: number }>;
  };
  expect(rows.find((r) => r.id === p.id)?.quantity).toBe(4);

  // The cap is cumulative: the one unit sold can be returned once, and a
  // second return of the same line finds nothing left.
  const first = await page.request.post(`${baseURL}/api/returns`, {
    data: { saleId, productId: p.id, returnedQuantity: 1, reason: "First" },
  });
  expect(first.status(), await first.text()).toBe(201);
  const second = await page.request.post(`${baseURL}/api/returns`, {
    data: { saleId, productId: p.id, returnedQuantity: 1, reason: "Second" },
  });
  expect(second.status()).toBe(400);
  expect(((await second.json()) as { error: string }).error).toBe("RETURN_EXCEEDS_SOLD");
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
