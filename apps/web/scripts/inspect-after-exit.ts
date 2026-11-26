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
  console.log("BEFORE EXIT cookies:");
  for (const c of await ctx.cookies()) {
    console.log(`  ${c.name} value-prefix=${(c.value ?? "").slice(0, 20)}`);
  }

  // Watch Set-Cookie response from /api/demo/exit
  page.on("response", async (r) => {
    if (r.url().includes("/api/demo/exit")) {
      const headers = await r.allHeaders();
      console.log("\n/api/demo/exit response headers:");
      console.log("  status:", r.status());
      console.log("  set-cookie:", headers["set-cookie"]);
    }
  });

  await page.getByRole("button", { name: /خروج من التجربة/ }).click();
  await page.waitForURL((u) => u.pathname === "/" || u.pathname.includes("welcome"), { timeout: 15000 });

  // Give the redirect a beat
  await new Promise((r) => setTimeout(r, 1000));

  console.log("\nAFTER EXIT cookies:");
  for (const c of await ctx.cookies()) {
    console.log(`  ${c.name} value-prefix=${(c.value ?? "").slice(0, 20)}`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
