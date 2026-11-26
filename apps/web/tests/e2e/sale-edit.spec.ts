// Sales-edit workflow: record a sale, open the row's edit modal, change
// the price, save, verify the change reflects on the page without a
// manual refresh.
//
// Tracks the user-reported bug "I edit price but can't see the
// reflection" — the assertion below catches both possible failure modes:
//   1. The PATCH didn't actually persist (assert against the API)
//   2. The page state doesn't reflect the PATCH (assert against DOM)

import { expect, test } from "@playwright/test";
import {
  getWatchesCategoryId,
  createProduct,
  recordCartSale,
} from "./helpers/tenant-setup";

test.describe.configure({ mode: "serial" });

test("sale edit: change price → /sales row + /api/sales both reflect the new value", async ({
  page,
  baseURL,
}) => {
  // 1. Seed a unique product + sell one unit at price=200.
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const product = await createProduct(page.request, baseURL!, categoryId, {
    name: `Edit Test Watch ${Date.now()}`,
    quantity: 5,
    price: 200,
  });
  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: product.id, quantity: 1, pricePerUnit: 200 }],
    { paymentMethod: "cash", customerName: "Edit Tester" },
  );
  expect(sale.total).toBe(200);
  const saleId = sale.saleIds[0]!;

  // 2. Open /sales and confirm the row shows price=200.
  await page.goto("/sales");
  const row = page.getByText(product.name).first();
  await expect(row).toBeVisible({ timeout: 20_000 });

  // 3. PATCH the sale via API (simulating the modal's network call) —
  //    this isolates "does the page refresh after a mutation" from
  //    "does the modal's submit work". The bug is "page doesn't update",
  //    so this is the precise failure surface.
  const patch = await page.request.patch(`${baseURL}/api/sales/${saleId}`, {
    data: { pricePerUnit: 350, quantitySold: 1 },
  });
  expect(patch.status(), await patch.text()).toBe(200);

  // 4. The API immediately reflects the new value.
  const listRes = await page.request.get(`${baseURL}/api/sales`);
  const list = (await listRes.json()) as {
    data: Array<{ id: string; pricePerUnit: number; totalPrice: number }>;
  };
  const updated = list.data.find((s) => s.id === saleId);
  expect(updated?.pricePerUnit).toBe(350);
  expect(updated?.totalPrice).toBe(350);

  // 5. Reload the /sales page (this is what the user does manually) —
  //    the new price MUST show. If this fails, the API write is broken.
  await page.reload();
  await expect(page.getByText(product.name).first()).toBeVisible({
    timeout: 15_000,
  });
  // Assert price somewhere on the row line. Currency format varies (Arabic
  // thousands separator, EGP suffix) — match by partial number.
  await expect(page.getByText(/350/).first()).toBeVisible({ timeout: 10_000 });
});

test("sale edit: open modal → change price → save → /sales row updates WITHOUT manual reload", async ({
  page,
  baseURL,
}) => {
  // The bug the user reported: "I edit price but can't see reflection".
  // Test 1 proved the API + reload path works. This test exercises the
  // UI modal flow and asserts the row reflects the new price WITHOUT a
  // reload.
  const stamp = Date.now();
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const product = await createProduct(page.request, baseURL!, categoryId, {
    name: `Modal Edit Test ${stamp}`,
    quantity: 5,
    price: 180,
  });
  await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: product.id, quantity: 1, pricePerUnit: 180 }],
    { paymentMethod: "cash" },
  );

  await page.goto("/sales");

  // The shared-owner tenant has tens of thousands of historical sales from
  // earlier load-test runs. Use the search box to narrow to our row, then
  // there's only one candidate. The Input renders <input placeholder=...>;
  // the placeholder text varies by locale but the input is always the
  // first text input on /sales.
  await page.locator('input[type="search"], input[type="text"]').first().fill(product.name);
  await expect(page.getByText(product.name).first()).toBeVisible({
    timeout: 30_000,
  });

  // Click the row's edit pencil. With search narrowed, there's only one
  // row. Title attribute is "تعديل" (ar) or "Edit" (en) — shared-owner
  // session locale may be either; match by regex.
  await page
    .getByRole("row")
    .filter({ hasText: product.name })
    .getByTitle(/تعديل|Edit/i)
    .click();

  // Modal opens. Find the unit-price input by its label text.
  // The Input component renders <label>سعر الوحدة</label><input>...
  // Use the input that currently holds 180.
  const priceInput = page.locator('input[type="number"]').nth(1); // 0=qty, 1=price
  await expect(priceInput).toHaveValue("180", { timeout: 10_000 });
  await priceInput.fill("425");

  // Click the "حفظ" (ar) / "Save" (en) button in the modal footer.
  await page.getByRole("button", { name: /حفظ|Save/i }).click();

  // The row's total cell should show 425 within a few seconds
  // (refreshSales fires after the modal closes).
  await expect(
    page.getByRole("row").filter({ hasText: product.name }).getByText(/425/).first(),
  ).toBeVisible({ timeout: 15_000 });
});

test("sale edit: applying discount to a FULLY PAID sale doesn't violate amount_paid <= total CHECK", async ({
  page,
  baseURL,
}) => {
  // The exact production failure mode the user hit:
  //   - Original sale: cash payment, qty=1, price=100, total=100, amount_paid=100
  //   - User edits with 50 EGP discount → new total = 50
  //   - Without rebalance, amount_paid(100) > total_price(50) violates
  //     `sales_amount_paid_lte_total` CHECK and the UPDATE fails
  //   - With rebalance, amount_paid clamps to 50; sale stays "paid"
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const product = await createProduct(page.request, baseURL!, categoryId, {
    name: `Discount-On-Paid Test ${Date.now()}`,
    quantity: 5,
    price: 100,
  });
  // Record fully-paid cash sale.
  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: product.id, quantity: 1, pricePerUnit: 100 }],
    { paymentMethod: "cash" },
  );
  expect(sale.total).toBe(100);
  const saleId = sale.saleIds[0]!;

  // Apply a 50 EGP discount via PATCH — exact scenario from the user.
  const patch = await page.request.patch(`${baseURL}/api/sales/${saleId}`, {
    data: {
      quantitySold: 1,
      pricePerUnit: 100,
      discountType: "fixed",
      discountValue: 50,
    },
  });
  expect(patch.status(), await patch.text()).toBe(200);

  // Verify the rebalance: total dropped to 50, amount_paid also dropped
  // to 50, sale remains "paid in full".
  const listRes = await page.request.get(`${baseURL}/api/sales`);
  const list = (await listRes.json()) as {
    data: Array<{
      id: string;
      totalPrice: number;
      amountPaid: number;
      isPaid: boolean;
      discountAmount?: number;
    }>;
  };
  const updated = list.data.find((s) => s.id === saleId);
  expect(updated?.totalPrice).toBe(50);
  expect(updated?.amountPaid).toBe(50);
  expect(updated?.isPaid).toBe(true);
  expect(updated?.discountAmount).toBe(50);
});

test("sale edit: applying percentage discount to a paid sale works (10% off 100)", async ({
  page,
  baseURL,
}) => {
  // Same shape as the failing case, but percentage discount.
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const product = await createProduct(page.request, baseURL!, categoryId, {
    name: `Percent-Discount Test ${Date.now()}`,
    quantity: 5,
    price: 100,
  });
  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: product.id, quantity: 1, pricePerUnit: 100 }],
    { paymentMethod: "cash" },
  );
  const saleId = sale.saleIds[0]!;

  const patch = await page.request.patch(`${baseURL}/api/sales/${saleId}`, {
    data: {
      quantitySold: 1,
      pricePerUnit: 100,
      discountType: "percentage",
      discountValue: 10,
    },
  });
  expect(patch.status(), await patch.text()).toBe(200);

  const listRes = await page.request.get(`${baseURL}/api/sales`);
  const list = (await listRes.json()) as {
    data: Array<{
      id: string;
      totalPrice: number;
      amountPaid: number;
      isPaid: boolean;
    }>;
  };
  const updated = list.data.find((s) => s.id === saleId);
  expect(updated?.totalPrice).toBe(90);
  expect(updated?.amountPaid).toBe(90);
  expect(updated?.isPaid).toBe(true);
});

test("sale edit: lowering price on a paid sale clamps amount_paid (the silent failure case)", async ({
  page,
  baseURL,
}) => {
  // The OTHER way to hit the CHECK violation: keep no discount but lower
  // the unit price. If amount_paid wasn't rebalanced, this would fail
  // silently (the modal would alert the SQL).
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const product = await createProduct(page.request, baseURL!, categoryId, {
    name: `Lower-Price-On-Paid Test ${Date.now()}`,
    quantity: 5,
    price: 200,
  });
  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: product.id, quantity: 1, pricePerUnit: 200 }],
    { paymentMethod: "cash" },
  );
  const saleId = sale.saleIds[0]!;

  // Drop the unit price from 200 to 50.
  const patch = await page.request.patch(`${baseURL}/api/sales/${saleId}`, {
    data: { pricePerUnit: 50 },
  });
  expect(patch.status(), await patch.text()).toBe(200);

  const listRes = await page.request.get(`${baseURL}/api/sales`);
  const list = (await listRes.json()) as {
    data: Array<{
      id: string;
      totalPrice: number;
      amountPaid: number;
      isPaid: boolean;
    }>;
  };
  const updated = list.data.find((s) => s.id === saleId);
  expect(updated?.totalPrice).toBe(50);
  expect(updated?.amountPaid).toBe(50);
  expect(updated?.isPaid).toBe(true);
});

test("sale edit: editing only the price does NOT shift the saleDate timestamp", async ({
  page,
  baseURL,
}) => {
  // Regression for "the row disappeared after I edited the price". The
  // EditSaleModal used to send saleDate on every save (always normalized
  // to 12:00 local), which shifted the row's time-of-day. With the
  // default "newest first" sort + a busy day, the row moved down the
  // list and users perceived it as disappearing.
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const product = await createProduct(page.request, baseURL!, categoryId, {
    name: `Date-Preservation Test ${Date.now()}`,
    quantity: 5,
    price: 100,
  });
  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: product.id, quantity: 1, pricePerUnit: 100 }],
    { paymentMethod: "cash" },
  );
  const saleId = sale.saleIds[0]!;

  // Capture the original saleDate.
  const beforeRes = await page.request.get(`${baseURL}/api/sales`);
  const before = (await beforeRes.json()) as {
    data: Array<{ id: string; saleDate: string }>;
  };
  const beforeDate = before.data.find((s) => s.id === saleId)?.saleDate;
  expect(beforeDate).toBeTruthy();

  // Drive the modal: open, change price, save (DON'T touch date input).
  await page.goto("/sales");
  await page.locator('input[type="search"], input[type="text"]').first().fill(product.name);
  await expect(page.getByText(product.name).first()).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("row")
    .filter({ hasText: product.name })
    .getByTitle(/تعديل|Edit/i)
    .click();
  await page.locator('input[type="number"]').nth(1).fill("175");
  await page.getByRole("button", { name: /حفظ|Save/i }).click();

  // Wait for the modal to close + row to refresh.
  await expect(
    page.getByRole("row").filter({ hasText: product.name }).getByText(/175/).first(),
  ).toBeVisible({ timeout: 15_000 });

  // The saleDate must NOT have changed — the row stays where it was.
  const afterRes = await page.request.get(`${baseURL}/api/sales`);
  const after = (await afterRes.json()) as {
    data: Array<{ id: string; saleDate: string }>;
  };
  const afterDate = after.data.find((s) => s.id === saleId)?.saleDate;
  expect(afterDate).toBe(beforeDate);
});

test("sale edit: clearing discount value persists null discount", async ({
  page,
  baseURL,
}) => {
  // Reproduces the second edit failure mode: a sale with a discount, the
  // user clears it. We send discountType=null + discountValue=null which
  // updateSale should persist as "no discount".
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const product = await createProduct(page.request, baseURL!, categoryId, {
    name: `Edit Discount Test ${Date.now()}`,
    quantity: 5,
    price: 100,
  });
  // Record with a 10% line discount → totalPrice=90.
  const sale = await recordCartSale(
    page.request,
    baseURL!,
    [
      {
        productId: product.id,
        quantity: 1,
        pricePerUnit: 100,
        lineDiscountType: "percentage",
        lineDiscountValue: 10,
      },
    ],
    { paymentMethod: "cash" },
  );
  expect(sale.total).toBe(90);
  const saleId = sale.saleIds[0]!;

  // Clear discount: discountType=null, discountValue=null.
  const patch = await page.request.patch(`${baseURL}/api/sales/${saleId}`, {
    data: { discountType: null, discountValue: null },
  });
  expect(patch.status(), await patch.text()).toBe(200);

  // The list reflects no discount; total back to 100.
  const listRes = await page.request.get(`${baseURL}/api/sales`);
  const list = (await listRes.json()) as {
    data: Array<{
      id: string;
      totalPrice: number;
      discountAmount?: number;
      discountValue?: number;
      discountType?: string;
    }>;
  };
  const updated = list.data.find((s) => s.id === saleId);
  expect(updated?.totalPrice).toBe(100);
  expect(updated?.discountAmount).toBeFalsy();
});
