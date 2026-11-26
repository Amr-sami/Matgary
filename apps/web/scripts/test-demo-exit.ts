// Focused regression test for the "خروج من التجربة" flow. The previous
// implementation crashed because the auth cookie outlived the deleted
// tenant on subsequent navigations. This script walks the full path and
// fails fast on any error or empty page after exit.

import { chromium } from "playwright";

const BASE = process.env.DEMO_TEST_BASE_URL ?? "https://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`page:${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Dev-mode noise we know about: CSP report-only warnings, nonce
    // hydration mismatch in dev's HotReload tree, Sentry CSP allowlist.
    if (text.includes("Content Security Policy")) return;
    if (text.includes("hydrated but some attributes")) return;
    if (text.includes("Failed to fetch RSC payload")) return;
    // Permission-checked endpoints (e.g. /api/settings) return 403 for
    // demo-owner roles that don't have the relevant permission. Not a crash.
    if (text.includes("Failed to load resource") && text.includes("403")) return;
    errors.push(`console:${text}`);
  });

  console.log("→ start demo session");
  await page.goto(`${BASE}/ar/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /تصفح المتجر التجريبي/ }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30000 });
  await page.waitForSelector("text=وضع التجربة", { timeout: 10000 });
  console.log("   ✓ in demo at", page.url());

  console.log("→ click خروج من التجربة");
  await page.getByRole("button", { name: /خروج من التجربة/ }).click();

  console.log("→ wait for landing on /ar/login");
  await page.waitForURL((url) => url.pathname.includes("/login"), {
    timeout: 20000,
  });
  await page.waitForLoadState("networkidle").catch(() => {});
  console.log("   landed on:", page.url());

  console.log("→ inspect cookies after exit");
  const cookiesAfter = await ctx.cookies();
  const sessionCookie = cookiesAfter.find((c) =>
    c.name.endsWith("authjs.session-token"),
  );
  console.log(
    "   cookies:",
    cookiesAfter.map((c) => `${c.name}=${(c.value ?? "").slice(0, 10)}…`).join(", "),
  );
  if (sessionCookie) {
    console.error(`   ✗ session cookie still present: ${sessionCookie.name}`);
    process.exit(1);
  }
  console.log("   ✓ session cookie cleared");

  console.log("→ /insights as anonymous should redirect to /ar/login");
  const insightsRes = await page.request.get(`${BASE}/insights`, {
    ignoreHTTPSErrors: true,
    maxRedirects: 0,
  });
  const status = insightsRes.status();
  const location = insightsRes.headers()["location"] ?? "";
  console.log(`   status=${status}  location=${location}`);
  if (status < 300 || status >= 400 || !location.includes("/login")) {
    console.error("   ✗ expected 30x redirect to /login");
    process.exit(1);
  }
  console.log("   ✓ middleware redirects anonymous user to /login");

  if (errors.length) {
    console.error("\n✗ Browser console / page errors during exit flow:");
    for (const e of errors.slice(0, 6)) console.error("   -", e);
    process.exit(1);
  }

  await browser.close();
  console.log("\n✅ Exit flow test passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
