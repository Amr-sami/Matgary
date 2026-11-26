// Purchase-order "external item" workflow. The PO builder lets the owner
// add an item that isn't in the catalog yet ("أضف صنف خارجي"). When the
// PO is received, those external items MUST become real catalog products
// so the owner can:
//   1. See them on /inventory
//   2. Search for them in /sales picker
//   3. Sell them again like any other product

import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface PoCreateLine {
  productId: string | null;
  productName: string;
  quantity: number;
  unitCost: number;
}

async function createPo(
  page: import("@playwright/test").Page,
  baseURL: string,
  supplierId: string,
  items: PoCreateLine[],
) {
  const res = await page.request.post(`${baseURL}/api/purchase-orders`, {
    data: { supplierId, items },
  });
  expect(res.status(), await res.text()).toBeLessThan(300);
  return (await res.json()) as { id: string };
}

async function receivePo(
  page: import("@playwright/test").Page,
  baseURL: string,
  poId: string,
  updateCost = false,
) {
  const res = await page.request.post(
    `${baseURL}/api/purchase-orders/${poId}/receive`,
    { data: { updateCost } },
  );
  expect(res.status(), await res.text()).toBeLessThan(300);
}

async function ensureSupplier(
  page: import("@playwright/test").Page,
  baseURL: string,
): Promise<string> {
  // Reuse any existing supplier; create one if none.
  const list = await page.request.get(`${baseURL}/api/suppliers`);
  const j = (await list.json()) as { data: Array<{ id: string }> };
  if (j.data.length > 0) return j.data[0]!.id;
  const created = await page.request.post(`${baseURL}/api/suppliers`, {
    data: { name: `Test Supplier ${Date.now()}` },
  });
  expect(created.status()).toBeLessThan(300);
  const body = (await created.json()) as { id?: string; data?: { id: string } };
  return body.id ?? body.data!.id;
}

test("PO external item: receiving promotes the item into the catalog", async ({
  page,
  baseURL,
}) => {
  const supplierId = await ensureSupplier(page, baseURL!);
  const externalName = `External Item ${Date.now()}`;

  // 1) Create a PO with ONE external line — productId: null.
  const po = await createPo(page, baseURL!, supplierId, [
    { productId: null, productName: externalName, quantity: 7, unitCost: 25 },
  ]);

  // 2) Before receive, the catalog doesn't have it.
  const beforeRes = await page.request.get(`${baseURL}/api/products`);
  const before = (await beforeRes.json()) as {
    data: Array<{ id: string; name: string }>;
  };
  expect(before.data.find((p) => p.name === externalName)).toBeUndefined();

  // 3) Receive the PO.
  await receivePo(page, baseURL!, po.id);

  // 4) The product now exists in the catalog with qty=7, cost=25,
  //    selling price = cost (the safe default — owner adjusts later).
  const afterRes = await page.request.get(`${baseURL}/api/products`);
  const after = (await afterRes.json()) as {
    data: Array<{
      id: string;
      name: string;
      quantity: number;
      price: number;
      costPrice?: number;
    }>;
  };
  const created = after.data.find((p) => p.name === externalName);
  expect(created).toBeTruthy();
  expect(created!.quantity).toBe(7);
  expect(created!.price).toBe(25);
  expect(created!.costPrice).toBe(25);
});

test("PO external item: owner-picked categoryId is honoured on receive", async ({
  page,
  baseURL,
}) => {
  // The owner picks a specific category for the external line in the
  // PO builder (e.g. "Sunglasses"). When the PO is received, the
  // materialised product must be filed under THAT category, not the
  // tenant's first one.
  const supplierId = await ensureSupplier(page, baseURL!);

  // Get the LAST category (not the default first one) so the test is
  // meaningful — if we used the first, we couldn't distinguish "picked"
  // from "fell back".
  const cats = await page.request.get(`${baseURL}/api/categories`);
  const { data: catList } = (await cats.json()) as {
    data: Array<{ id: string; key: string }>;
  };
  expect(catList.length).toBeGreaterThan(1);
  const targetCategoryId = catList[catList.length - 1]!.id;

  const externalName = `Custom-Category Item ${Date.now()}`;
  const po = await createPo(page, baseURL!, supplierId, [
    {
      productId: null,
      productName: externalName,
      quantity: 2,
      unitCost: 30,
      categoryId: targetCategoryId,
    } as PoCreateLine & { categoryId: string },
  ]);
  await receivePo(page, baseURL!, po.id);

  const after = await page.request.get(`${baseURL}/api/products`);
  const list = (await after.json()) as {
    data: Array<{ name: string; category: string }>;
  };
  const created = list.data.find((p) => p.name === externalName);
  expect(created).toBeTruthy();
  expect(created!.category).toBe(targetCategoryId);
});

test("PO external item: created product carries the PO's supplierId", async ({
  page,
  baseURL,
}) => {
  // The bug: external items showed up in /inventory with no supplier
  // linked, even though the PO had a supplier selected. The owner's
  // catalog edit modal showed "اختر مورد…" instead of the supplier
  // they'd already picked at PO time.
  const supplierId = await ensureSupplier(page, baseURL!);
  const externalName = `Supplier-Linked Item ${Date.now()}`;

  const po = await createPo(page, baseURL!, supplierId, [
    { productId: null, productName: externalName, quantity: 3, unitCost: 50 },
  ]);
  await receivePo(page, baseURL!, po.id);

  const afterRes = await page.request.get(`${baseURL}/api/products`);
  const after = (await afterRes.json()) as {
    data: Array<{ id: string; name: string; supplierId?: string | null }>;
  };
  const created = after.data.find((p) => p.name === externalName);
  expect(created).toBeTruthy();
  expect(created!.supplierId).toBe(supplierId);
});

test("PO external item: matching an existing product without a supplier back-fills it", async ({
  page,
  baseURL,
}) => {
  // Existing-product path: owner created a product earlier via the
  // quick-add or full add-product flow WITHOUT picking a supplier.
  // Later they buy a restock from supplier X via a PO referencing the
  // same name as external. The receive flow should link the existing
  // product to supplier X (since it had no supplier).
  const supplierId = await ensureSupplier(page, baseURL!);
  const productName = `Backfill Supplier ${Date.now()}`;

  // 1) Get a category to seed the existing product.
  const cats = await page.request.get(`${baseURL}/api/categories`);
  const { data: catList } = (await cats.json()) as {
    data: Array<{ id: string; key: string }>;
  };
  const categoryId = catList[0]!.id;

  // 2) Create the existing product with NO supplier.
  const created = await page.request.post(`${baseURL}/api/products`, {
    data: { name: productName, categoryId, quantity: 0, price: 10 },
  });
  expect(created.status()).toBe(201);
  const { id: productId } = (await created.json()) as { id: string };

  // 3) Receive a PO with that name as external.
  const po = await createPo(page, baseURL!, supplierId, [
    { productId: null, productName, quantity: 2, unitCost: 8 },
  ]);
  await receivePo(page, baseURL!, po.id);

  // 4) The existing product now has the PO's supplier linked.
  const after = await page.request.get(`${baseURL}/api/products`);
  const list = (await after.json()) as {
    data: Array<{ id: string; supplierId?: string | null; quantity: number }>;
  };
  const refreshed = list.data.find((p) => p.id === productId);
  expect(refreshed).toBeTruthy();
  expect(refreshed!.supplierId).toBe(supplierId);
  expect(refreshed!.quantity).toBe(2); // stock incremented from the PO
});

test("PO external item: same name twice on one PO merges into ONE product", async ({
  page,
  baseURL,
}) => {
  // De-dup contract — two lines with the same name should stock the same
  // catalog row, not create two.
  const supplierId = await ensureSupplier(page, baseURL!);
  const name = `Twice External ${Date.now()}`;

  const po = await createPo(page, baseURL!, supplierId, [
    { productId: null, productName: name, quantity: 3, unitCost: 10 },
    { productId: null, productName: name, quantity: 5, unitCost: 10 },
  ]);
  await receivePo(page, baseURL!, po.id);

  const after = await page.request.get(`${baseURL}/api/products`);
  const list = (await after.json()) as {
    data: Array<{ name: string; quantity: number }>;
  };
  const matches = list.data.filter((p) => p.name === name);
  expect(matches.length).toBe(1);
  expect(matches[0]!.quantity).toBe(8); // 3 + 5
});

test("PO external item: a second PO with the SAME external name restocks the existing product", async ({
  page,
  baseURL,
}) => {
  // The "case-insensitive name match" path. Same owner orders the same
  // external item across two POs — the second PO should restock the
  // product the first PO created, not duplicate it.
  const supplierId = await ensureSupplier(page, baseURL!);
  const name = `Restock External ${Date.now()}`;

  const po1 = await createPo(page, baseURL!, supplierId, [
    { productId: null, productName: name, quantity: 4, unitCost: 20 },
  ]);
  await receivePo(page, baseURL!, po1.id);

  const po2 = await createPo(page, baseURL!, supplierId, [
    {
      productId: null,
      // Different casing — should still match.
      productName: name.toUpperCase(),
      quantity: 6,
      unitCost: 20,
    },
  ]);
  await receivePo(page, baseURL!, po2.id);

  const after = await page.request.get(`${baseURL}/api/products`);
  const list = (await after.json()) as {
    data: Array<{ name: string; quantity: number }>;
  };
  // Case-insensitive match: should be one row, name from the first PO.
  const matches = list.data.filter(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  expect(matches.length).toBe(1);
  expect(matches[0]!.quantity).toBe(10); // 4 + 6
});
