// One-off: log every cookie Auth.js sets after a demo login, so we know
// exactly which names to clear in /api/demo/exit.

import { chromium } from "playwright";

const BASE = process.env.DEMO_TEST_BASE_URL ?? "https://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/ar/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /تصفح المتجر التجريبي/ }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 });
  await page.waitForSelector("text=وضع التجربة", { timeout: 10000 });
  const cookies = await ctx.cookies();
  console.log("Auth.js cookies after demo login:");
  for (const c of cookies) {
    console.log(`  ${c.name}  (domain=${c.domain}  secure=${c.secure}  httpOnly=${c.httpOnly}  size=${(c.value ?? "").length})`);
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
