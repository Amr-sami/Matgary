// Use Playwright to log in as each scale tenant + dump cookies as a
// single Cookie header string per tenant. Faster than re-implementing
// Auth.js v5's CSRF + credentials dance.
//
// Usage:
//   T100_EMAIL=... T1K_EMAIL=... T10K_EMAIL=... npx tsx tests/perf/login-cookies.ts
//   → writes tests/perf/.cookies/{p100,p1k,p10k}.txt

import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const BASE = process.env.BASE ?? "http://localhost:3100";
const OUT = path.resolve(process.cwd(), "tests/perf/.cookies");

interface Target {
  scale: string;
  email: string;
  password: string;
}

const TARGETS: Target[] = [
  { scale: "p100", email: process.env.T100_EMAIL!, password: process.env.T100_PASSWORD! },
  { scale: "p1k", email: process.env.T1K_EMAIL!, password: process.env.T1K_PASSWORD! },
  { scale: "p10k", email: process.env.T10K_EMAIL!, password: process.env.T10K_PASSWORD! },
];

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const t of TARGETS) {
    if (!t.email) {
      // eslint-disable-next-line no-console
      console.log(`skip ${t.scale}: no email`);
      continue;
    }
    const ctx = await browser.newContext({
      baseURL: BASE,
      locale: "ar-EG",
      timezoneId: "Africa/Cairo",
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60_000);
    await page.goto("/ar/login");
    await page.locator('input[name="email"]').fill(t.email);
    await page.locator('input[name="password"]').fill(t.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 });
    const cookies = await ctx.cookies();
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await fs.writeFile(path.join(OUT, `${t.scale}.txt`), header);
    // eslint-disable-next-line no-console
    console.log(`${t.scale}: ${cookies.length} cookies written`);
    await ctx.close();
  }
  await browser.close();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
