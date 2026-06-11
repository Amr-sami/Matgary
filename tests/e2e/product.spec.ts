// Product create workflow. Single most-used catalog mutation.

import { expect, test } from "@playwright/test";
import {
  getWatchesCategoryId,
} from "./helpers/tenant-setup";

test.describe.configure({ mode: "serial" });

test("product happy path: create → list contains it", async ({
  page,
  baseURL,
}) => {

  const catId = await getWatchesCategoryId(page.request, baseURL!);
  const name = `Catalog Watch ${Date.now()}`;
  const create = await page.request.post(`${baseURL}/api/products`, {
    data: {
      name,
      categoryId: catId,
      quantity: 7,
      price: 320,
      costPrice: 180,
      lowStockThreshold: 1,
    },
  });
  expect(create.status()).toBe(201);

  const list = await page.request.get(`${baseURL}/api/products`);
  const { data } = (await list.json()) as {
    data: Array<{ id: string; name: string; quantity: number }>;
  };
  const found = data.find((p) => p.name === name);
  expect(found).toBeTruthy();
  expect(found!.quantity).toBe(7);
});

test("product validation: zod rejects negative price", async ({
  page,
  baseURL,
}) => {

  const catId = await getWatchesCategoryId(page.request, baseURL!);
  const res = await page.request.post(`${baseURL}/api/products`, {
    data: {
      name: "Bad",
      categoryId: catId,
      quantity: 1,
      price: -5,
    },
  });
  expect(res.status()).toBe(400);
});

test("product validation: missing categoryId rejected", async ({
  page,
  baseURL,
}) => {

  const res = await page.request.post(`${baseURL}/api/products`, {
    data: { name: "Bad", quantity: 1, price: 1 },
  });
  expect(res.status()).toBe(400);
});

test("product authz: anonymous POST returns 401", async ({
  playwright,
  baseURL,
}) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await anon.post(`${baseURL}/api/products`, {
    data: {
      name: "x",
      categoryId: "00000000-0000-0000-0000-000000000000",
      quantity: 1,
      price: 1,
    },
  });
  expect(res.status()).toBe(401);
  await anon.dispose();
});
