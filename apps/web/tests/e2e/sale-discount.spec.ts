// Sale-with-discount math. Discount edge cases are the most-changed area
// of the POS code and the most painful to debug from a customer complaint.
// Every assertion here corresponds to an invariant the cashier relies on:
//
//   - line discount % subtracts before order discount
//   - order discount distributes proportionally across lines
//   - the sum of lines == cart total (no rounding leak)

import { expect, test } from "@playwright/test";
import {
  getWatchesCategoryId,
  createProduct,
  recordCartSale,
} from "./helpers/tenant-setup";

test.describe.configure({ mode: "serial" });

test("line discount: 10% off one item is reflected in total", async ({
  page,
  baseURL,
}) => {
  const catId = await getWatchesCategoryId(page.request, baseURL!);
  const p = await createProduct(page.request, baseURL!, catId, {
    quantity: 5,
    price: 100,
  });

  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [
      {
        productId: p.id,
        quantity: 1,
        pricePerUnit: 100,
        lineDiscountType: "percentage",
        lineDiscountValue: 10,
      },
    ],
    { paymentMethod: "cash" },
  );
  expect(sale.total).toBe(90);
});

test("line discount: fixed EGP off", async ({ page, baseURL }) => {
  const catId = await getWatchesCategoryId(page.request, baseURL!);
  const p = await createProduct(page.request, baseURL!, catId, {
    quantity: 5,
    price: 150,
  });

  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [
      {
        productId: p.id,
        quantity: 2,
        pricePerUnit: 150,
        lineDiscountType: "fixed",
        lineDiscountValue: 30,
      },
    ],
    { paymentMethod: "cash" },
  );
  // 2 × 150 − 30 = 270.
  expect(sale.total).toBe(270);
});

test("order discount: 50 EGP off a 200 EGP cart yields 150", async ({
  page,
  baseURL,
}) => {
  const catId = await getWatchesCategoryId(page.request, baseURL!);
  const p = await createProduct(page.request, baseURL!, catId, {
    quantity: 5,
    price: 100,
  });

  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: p.id, quantity: 2, pricePerUnit: 100 }],
    {
      paymentMethod: "cash",
      orderDiscountType: "fixed",
      orderDiscountValue: 50,
    },
  );
  expect(sale.total).toBe(150);
});

test("multi-line: order discount distributes across two lines", async ({
  page,
  baseURL,
}) => {
  const catId = await getWatchesCategoryId(page.request, baseURL!);
  const a = await createProduct(page.request, baseURL!, catId, {
    name: "A",
    quantity: 5,
    price: 100,
  });
  const b = await createProduct(page.request, baseURL!, catId, {
    name: "B",
    quantity: 5,
    price: 100,
  });

  // 200 cart, 20% order discount = 160 total.
  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [
      { productId: a.id, quantity: 1, pricePerUnit: 100 },
      { productId: b.id, quantity: 1, pricePerUnit: 100 },
    ],
    {
      paymentMethod: "cash",
      orderDiscountType: "percentage",
      orderDiscountValue: 20,
    },
  );
  expect(sale.total).toBe(160);

  // Per-line totals come back via /api/sales and must sum to the cart total.
  const listRes = await page.request.get(`${baseURL}/api/sales`);
  const { data } = (await listRes.json()) as {
    data: Array<{ id: string; totalPrice: number; invoiceId: string }>;
  };
  const rows = data.filter((s) => s.invoiceId === sale.invoiceId);
  expect(rows.length).toBe(2);
  const sum = rows.reduce((acc, r) => acc + Number(r.totalPrice), 0);
  expect(sum).toBe(160);
});
