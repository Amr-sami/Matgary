import { expect, test } from "@playwright/test";

// H05 — End-to-end happy path. Catches the worst regressions: broken
// signup, broken onboarding, broken sale recording, broken insights
// aggregation. Browser-driven where the value-add of a real browser is
// highest (auth + Arabic RTL forms); API-driven for product creation +
// sale recording so the test isn't hostage to the 3-step add-product
// picker UI churning every time a category is added.
//
// Owns its own data via a per-run timestamp prefix so two parallel runs
// (e.g. two PRs in CI) cannot collide on a tenant slug or email.

test.describe.configure({ mode: "serial" });

// Signup → onboarding smoke must start anonymous.
test.use({ storageState: { cookies: [], origins: [] } });

test("signup → onboarding → product → sale → insights", async ({
  page,
  baseURL,
}) => {
  const stamp = Date.now();
  const email = `e2e-${stamp}@matgary.test`;
  const password = "password123!";
  const handle = `e2e${stamp}`;
  const shopName = `E2E Shop ${stamp}`;
  const productName = `E2E Watch ${stamp}`;

  // ── 1. Signup, step 1 (email + password) ───────────────────────────────
  await page.goto("/signup");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "التالي" }).click();

  // ── 2. Signup, step 2 (store identity) ─────────────────────────────────
  await page.locator('input[name="storeName"]').fill(shopName);
  await page.locator('input[name="storeHandle"]').fill(handle);
  // Wait for the debounced live availability check to resolve. The
  // success message ("متاح ✓") renders in two paragraphs (helper text +
  // status pill) — use .first() so the strict-mode locator doesn't trip.
  await expect(page.getByText("متاح").first()).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();

  // ── 3. Onboarding (3 steps; cornerstore preset is the default) ─────────
  await page.waitForURL(/\/onboarding/, { timeout: 15_000 });
  await page.locator('input[placeholder="متجر السعادة"]').fill(shopName);
  await page.getByRole("button", { name: "التالي" }).click(); // step 1 → 2
  await page.getByRole("button", { name: "التالي" }).click(); // step 2 → 3
  await page.getByRole("button", { name: "ابدأ" }).click();

  // ── 4. Landed on the dashboard ─────────────────────────────────────────
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });

  // ── 5. Find a real category id (cornerstore preset → "watches") ────────
  const catsRes = await page.request.get(`${baseURL}/api/categories`);
  expect(catsRes.ok()).toBe(true);
  const { data: cats } = (await catsRes.json()) as {
    data: Array<{ id: string; key: string }>;
  };
  const watches = cats.find((c) => c.key === "watches");
  expect(watches, "watches category seeded by cornerstore preset").toBeTruthy();

  // ── 6. Create one product via the API (session cookie travels) ─────────
  const createProd = await page.request.post(`${baseURL}/api/products`, {
    data: {
      name: productName,
      categoryId: watches!.id,
      quantity: 5,
      price: 200,
      lowStockThreshold: 1,
    },
  });
  expect(createProd.status(), await createProd.text()).toBe(201);
  const { id: productId } = (await createProd.json()) as { id: string };

  // ── 7. Record a cash sale via the cart endpoint ────────────────────────
  const sale = await page.request.post(`${baseURL}/api/sales/cart`, {
    data: {
      lines: [
        { productId, quantity: 1, pricePerUnit: 200 },
      ],
      options: { paymentMethod: "cash", customerName: "E2E Buyer" },
    },
  });
  expect(sale.status(), await sale.text()).toBe(201);
  const saleBody = (await sale.json()) as { total: number };
  expect(saleBody.total).toBe(200);

  // ── 8. /sales page lists the product just sold ─────────────────────────
  await page.goto("/sales");
  await expect(
    page.getByText(productName).first(),
  ).toBeVisible({ timeout: 10_000 });

  // ── 9. /insights overview reflects the day's revenue (200 EGP) ─────────
  await page.goto("/insights");
  await expect(page.getByText("200")).toBeVisible({ timeout: 10_000 });
});
