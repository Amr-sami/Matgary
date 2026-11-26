// Expense workflow. Single + recurring. Listed by /api/expenses.

import { expect, test } from "@playwright/test";


test.describe.configure({ mode: "serial" });

test("expense happy path: one-off expense appears in /api/expenses", async ({
  page,
  baseURL,
}) => {

  const title = `Rent ${Date.now()}`;
  const res = await page.request.post(`${baseURL}/api/expenses`, {
    data: {
      title,
      amount: 5000,
      category: "rent",
      isRecurring: false,
    },
  });
  expect(res.status(), await res.text()).toBeLessThan(300);

  const list = await page.request.get(`${baseURL}/api/expenses`);
  expect(list.ok()).toBe(true);
  const { data } = (await list.json()) as {
    data: Array<{ title: string; amount: number }>;
  };
  expect(data.some((e) => e.title === title)).toBe(true);
});

test("expense validation: missing required fields rejected with 400", async ({
  page,
  baseURL,
}) => {

  const res = await page.request.post(`${baseURL}/api/expenses`, {
    // Missing title + amount + category.
    data: {},
  });
  expect(res.status()).toBe(400);
});

test("expense authz: anonymous POST returns 401", async ({
  playwright,
  baseURL,
}) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await anon.post(`${baseURL}/api/expenses`, {
    data: { title: "x", amount: 1, category: "other" },
  });
  expect(res.status()).toBe(401);
  await anon.dispose();
});
