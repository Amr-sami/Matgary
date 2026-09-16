// Shared owner-tenant fixture used by every workflow spec.
//
// Each suite gets its own fresh tenant (timestamped slug + email) so suites
// don't observe each other's data. The "owner" sign-in cookies are stashed
// on the BrowserContext via Playwright's `storageState` so subsequent tests
// in the same suite skip the signup/onboarding dance.
//
// Why per-suite rather than one global tenant? Tests for permission
// restrictions need a staff user too; collecting all that into one shared
// state file would invert the test pyramid (one big "kitchen sink" sign-in
// vs many fast ones).

import { expect, type APIRequestContext, type Page } from "@playwright/test";

export interface OwnerCredentials {
  email: string;
  password: string;
  handle: string;
  shopName: string;
}

/** Mint a fresh, unique owner credential set. */
export function freshOwner(prefix = "e2e"): OwnerCredentials {
  const stamp = Date.now() + Math.floor(Math.random() * 1_000);
  return {
    email: `${prefix}-${stamp}@matgary.test`,
    password: "TestPass123!",
    handle: `${prefix}${stamp}`,
    shopName: `Test Shop ${stamp}`,
  };
}

/**
 * Drive the signup → onboarding → dashboard flow in a browser. Slow but
 * the canonical happy-path; reusing the existing UI gives us a free
 * regression test on those flows.
 *
 * On success the BrowserContext has the auth cookies set and is parked at
 * "/" so callers can immediately navigate to whatever page they're testing.
 */
export async function signupOwner(
  page: Page,
  creds: OwnerCredentials,
): Promise<void> {
  await page.goto("/signup");
  await page.locator('input[name="email"]').fill(creds.email);
  await page.locator('input[name="password"]').fill(creds.password);
  await page.getByRole("button", { name: "التالي" }).click();

  await page.locator('input[name="storeName"]').fill(creds.shopName);
  await page.locator('input[name="storeHandle"]').fill(creds.handle);
  // The signup page keeps step 1's availability indicator in the DOM (just
  // hidden) when step 2 is active — strict-mode locators will see both.
  // Wait for the handle-check endpoint to resolve, then for the submit
  // button to become enabled (its contract: "all fields validated").
  await page
    .waitForResponse(
      (r) =>
        r.url().includes("/api/account/store-handle/check") &&
        r.url().includes(encodeURIComponent(creds.handle)),
      { timeout: 15_000 },
    )
    .catch(() => {
      /* check may have already resolved before the listener attached */
    });
  const submit = page.getByRole("button", { name: "إنشاء الحساب" });
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click();

  // Dev-mode first compile of /onboarding can take 20-30s; give it 45s
  // before declaring a real failure.
  await page.waitForURL(/\/onboarding/, { timeout: 45_000 });
  await page
    .locator('input[placeholder="متجر السعادة"]')
    .fill(creds.shopName);
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByRole("button", { name: "ابدأ" }).click();

  // Dashboard first-render: same compile budget.
  await page.waitForURL((url) => url.pathname === "/", { timeout: 45_000 });
}

/** Resolve the cornerstore preset's "watches" category id. */
export async function getWatchesCategoryId(
  request: APIRequestContext,
  baseURL: string,
): Promise<string> {
  const res = await request.get(`${baseURL}/api/categories`);
  expect(res.ok()).toBe(true);
  const { data } = (await res.json()) as {
    data: Array<{ id: string; key: string }>;
  };
  const cat = data.find((c) => c.key === "watches");
  expect(cat, "watches category should be seeded").toBeTruthy();
  return cat!.id;
}

interface CreateProductOpts {
  name?: string;
  quantity?: number;
  price?: number;
  costPrice?: number;
  lowStockThreshold?: number;
}

export async function createProduct(
  request: APIRequestContext,
  baseURL: string,
  categoryId: string,
  opts: CreateProductOpts = {},
): Promise<{ id: string; name: string; price: number; quantity: number }> {
  const name = opts.name ?? `Product ${Date.now()}`;
  const price = opts.price ?? 200;
  const quantity = opts.quantity ?? 5;
  const res = await request.post(`${baseURL}/api/products`, {
    data: {
      name,
      categoryId,
      quantity,
      price,
      costPrice: opts.costPrice ?? 120,
      lowStockThreshold: opts.lowStockThreshold ?? 1,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { id: string };
  return { id: body.id, name, price, quantity };
}

export interface CartLine {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType?: "percentage" | "fixed";
  lineDiscountValue?: number;
}

export interface CartOptions {
  paymentMethod?: "cash" | "instapay" | "card" | "deferred";
  customerName?: string;
  customerPhone?: string;
  orderDiscountType?: "percentage" | "fixed";
  orderDiscountValue?: number;
  amountPaidNow?: number;
  note?: string;
}

export async function recordCartSale(
  request: APIRequestContext,
  baseURL: string,
  lines: CartLine[],
  options: CartOptions = {},
): Promise<{ invoiceId: string; saleIds: string[]; total: number }> {
  const res = await request.post(`${baseURL}/api/sales/cart`, {
    data: { lines, options },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as {
    invoiceId: string;
    saleIds: string[];
    total: number;
  };
}
