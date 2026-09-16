// Customer workflow. Matgary has no standalone customer entity — a
// "customer" is a denormalised snapshot on `sales` keyed by phone. The
// /customers page reads from sales. So the customer "happy path" is:
// record a sale with a name+phone, then assert the customer endpoint
// returns it.

import { expect, test } from "@playwright/test";
import {
  getWatchesCategoryId,
  createProduct,
  recordCartSale,
} from "./helpers/tenant-setup";

test.describe.configure({ mode: "serial" });

test("customer happy path: sale with phone surfaces on /api/customers/by-phone", async ({
  page,
  baseURL,
}) => {

  const catId = await getWatchesCategoryId(page.request, baseURL!);
  const p = await createProduct(page.request, baseURL!, catId, {
    quantity: 5,
    price: 250,
  });

  const phone = "01001234567";
  const customerName = "أحمد محمد";
  await recordCartSale(
    page.request,
    baseURL!,
    [{ productId: p.id, quantity: 1, pricePerUnit: 250 }],
    {
      paymentMethod: "cash",
      customerName,
      customerPhone: phone,
    },
  );

  // Normalised: +20 prefix is applied.
  const lookup = await page.request.get(
    `${baseURL}/api/customers/by-phone/${encodeURIComponent("+20" + phone.slice(1))}`,
  );
  expect(lookup.status()).toBe(200);
  const body = (await lookup.json()) as {
    history?: Array<{ totalPrice: number }>;
    totalSpent?: number;
  };
  // The exact shape varies, but at minimum we should see the sale total.
  const found = JSON.stringify(body).includes("250");
  expect(found).toBe(true);
});

test("customer authz: anonymous lookup returns 401", async ({
  playwright,
  baseURL,
}) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await anon.get(
    `${baseURL}/api/customers/by-phone/${encodeURIComponent("+201001234567")}`,
  );
  expect(res.status()).toBe(401);
  await anon.dispose();
});
