// Re-categorise a product from the inventory edit modal — exposes the
// `categoryId` patch path that didn't exist until the inventory edit
// modal got its category dropdown.

import { expect, test } from "@playwright/test";
import {
  createProduct,
  getWatchesCategoryId,
} from "./helpers/tenant-setup";

test.describe.configure({ mode: "serial" });

test("inventory edit: PATCH categoryId moves the product to a different category", async ({
  page,
  baseURL,
}) => {
  // Two categories needed — the cornerstore preset seeds at least 3.
  const cats = await page.request.get(`${baseURL}/api/categories`);
  const { data: catList } = (await cats.json()) as {
    data: Array<{ id: string; key: string }>;
  };
  expect(catList.length).toBeGreaterThan(1);
  const watchesId = await getWatchesCategoryId(page.request, baseURL!);
  const otherCategory = catList.find((c) => c.id !== watchesId)!;

  // Create a product in "watches".
  const product = await createProduct(page.request, baseURL!, watchesId, {
    name: `Recategorise Test ${Date.now()}`,
    quantity: 5,
    price: 100,
  });

  // PATCH the categoryId to the other category.
  const patch = await page.request.patch(`${baseURL}/api/products/${product.id}`, {
    data: { categoryId: otherCategory.id },
  });
  expect(patch.status(), await patch.text()).toBe(200);

  // List shows the product now under the new category.
  const listRes = await page.request.get(`${baseURL}/api/products`);
  const list = (await listRes.json()) as {
    data: Array<{ id: string; category: string }>;
  };
  const updated = list.data.find((p) => p.id === product.id);
  expect(updated).toBeTruthy();
  expect(updated!.category).toBe(otherCategory.id);
});

test("inventory edit: PATCH invalid categoryId returns 400", async ({
  page,
  baseURL,
}) => {
  const categoryId = await getWatchesCategoryId(page.request, baseURL!);
  const product = await createProduct(page.request, baseURL!, categoryId, {
    name: `Bad Recategorise ${Date.now()}`,
    quantity: 1,
    price: 1,
  });
  const patch = await page.request.patch(`${baseURL}/api/products/${product.id}`, {
    data: { categoryId: "not-a-uuid" },
  });
  expect(patch.status()).toBe(400);
});
