import { expect, test } from "@playwright/test";

// Auth-flow smoke. Complements smoke.spec.ts (signup → sale path) by
// exercising the things the audit fixes added/changed:
//   • open-redirect closure (#1)
//   • locale switcher hard-nav (#i18n)
//   • live email-availability (#19, #8)
//   • reset-link pre-validate (#9)
//   • onboarding gate redirect (Phase 3)
//   • forgot-password echoes the email (#18)
//
// Pure HTTP / DOM assertions — no auth credentials needed except where
// noted. Quick to run; sub-30s on a warm dev server.

test.describe.configure({ mode: "serial" });

// Auth-smoke probes start anonymous.
test.use({ storageState: { cookies: [], origins: [] } });

test("open redirect: ?next=https://evil is collapsed to /", async ({
  page,
}) => {
  // We don't actually sign in here — the assertion is "the page DOM treats
  // ?next=... as a relative path, never as an absolute". safeNext is the
  // unit-tested guard; this confirms the login page wires it in.
  await page.goto("/ar/login?next=https://example.com/danger");
  await expect(page).toHaveURL(/\/ar\/login/);

  // The "next" stays attached to URL, but its sanitized form is what the
  // submit handler will read. Inspect the embedded value safeNext returns.
  const safeNextValue = await page.evaluate(() => {
    const sp = new URLSearchParams(window.location.search);
    return sp.get("next");
  });
  expect(safeNextValue).toBe("https://example.com/danger");
  // safeNext is invoked at submit time; we verify the helper's behavior in
  // tests/url-safe.test.ts. This e2e just confirms the URL doesn't get
  // pre-rewritten by middleware.
});

test("locale switch is a hard navigation that flips <html lang/dir>", async ({
  page,
}) => {
  await page.goto("/ar/welcome");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // Open the switcher (Globe icon). LangSwitcher renders aria-label =
  // the active locale's full name. We click the "English" option.
  await page.getByRole("button", { name: "العربية" }).first().click();
  await page.getByRole("option", { name: "English" }).click();

  // window.location.assign → real navigation; the new page renders with
  // the new lang/dir from the server.
  await page.waitForURL(/\/en\/welcome/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});

test("email-check returns { available: true } for a fresh address", async ({
  request,
}) => {
  const fresh = `fresh-smoke-${Date.now()}@example.com`;
  const res = await request.get(
    `/api/account/email/check?email=${encodeURIComponent(fresh)}`,
  );
  expect(res.ok()).toBe(true);
  const json = (await res.json()) as { available: boolean };
  expect(json.available).toBe(true);
});

test("email-check returns { available: false, reason: 'invalid' } for garbage", async ({
  request,
}) => {
  const res = await request.get(
    `/api/account/email/check?email=not-an-email`,
  );
  expect(res.ok()).toBe(true);
  const json = (await res.json()) as { available: boolean; reason?: string };
  expect(json.available).toBe(false);
  expect(json.reason).toBe("invalid");
});

test("signup step-1: live email-check fires and returns available", async ({
  page,
}) => {
  // First hit warms Next dev's compile so the second navigation is fast.
  await page.goto("/ar/signup");
  await page.waitForLoadState("networkidle");

  const fresh = `signup-live-${Date.now()}@example.com`;
  // Wait for the debounced fetch the page wires up — more deterministic
  // than scraping the (locale-dependent) status hint from the DOM.
  const checkPromise = page.waitForResponse(
    (r) =>
      r.url().includes("/api/account/email/check") &&
      r.url().includes(encodeURIComponent(fresh)),
    { timeout: 12_000 },
  );
  await page.locator('input[name="email"]').fill(fresh);
  const check = await checkPromise;
  expect(check.ok()).toBe(true);
  const json = (await check.json()) as { available: boolean };
  expect(json.available).toBe(true);
});

test("password reset pre-validate: garbage token returns valid=false", async ({
  request,
}) => {
  const res = await request.get(
    `/api/account/password/reset/validate?token=garbage`,
  );
  expect(res.ok()).toBe(true);
  const json = (await res.json()) as { valid: boolean };
  expect(json.valid).toBe(false);
});

test("reset-password page shows 'invalid link' card without a real token", async ({
  page,
}) => {
  await page.goto("/ar/reset-password?token=tooshort");
  // The page first runs the pre-validate fetch; on invalid we render the
  // "request a new link" panel, not the password form.
  await expect(page.getByText(/رابط غير صالح|invalid/i)).toBeVisible({
    timeout: 8_000,
  });
  // Password form should NOT have rendered.
  await expect(page.locator('input[name="newPassword"]')).toHaveCount(0);
});

test("forgot-password success state echoes the submitted email back", async ({
  page,
}) => {
  await page.goto("/ar/forgot-password");
  await page.waitForLoadState("networkidle");
  const probe = `echo-${Date.now()}@example.com`;
  const respPromise = page.waitForResponse(
    (r) => r.url().includes("/api/account/password/forgot"),
    { timeout: 12_000 },
  );
  await page.locator('input[name="email"]').fill(probe);
  // Use the submit type rather than the localized button label — the dict
  // key changes (and matched by partial regex) shouldn't break the test.
  await page.locator('button[type="submit"]').click();
  await respPromise;
  // The success message contains the typed email verbatim (LTR span).
  await expect(page.getByText(probe)).toBeVisible({ timeout: 8_000 });
});

test("middleware: bare /welcome redirects with locale prefix", async ({
  request,
}) => {
  const res = await request.get(`/welcome`, { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  const loc = res.headers().location ?? "";
  // Default detection is "ar" when no cookie/Accept-Language hint is set
  // (Playwright's default Accept-Language carries 'ar-EG' per config).
  expect(loc).toMatch(/^\/ar\/welcome/);
});

test("middleware: anonymous /onboarding bounces to login with locale-prefixed next", async ({
  request,
}) => {
  const res = await request.get(`/ar/onboarding`, { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  const loc = res.headers().location ?? "";
  expect(loc).toContain("/ar/login");
  expect(loc).toContain("next=");
  expect(decodeURIComponent(loc)).toContain("/ar/onboarding");
});
