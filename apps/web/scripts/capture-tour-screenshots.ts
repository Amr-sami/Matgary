// Captures real screenshots of the running dev server for the onboarding
// tour (step 4). For each locale (ar + en) it:
//   1. Flips users.locale on the seeded `amr@matgary.local` row.
//   2. Bumps token_version so any cached JWT is invalidated.
//   3. Deletes the cached `resolveTenantContext` entry from Redis so the
//      JWT callback rebuilds with the new locale (otherwise the 60s TTL
//      window would serve us the old locale claim).
//   4. Logs in fresh and snaps each tour route.
//
// Saves to:
//
//   public/onboarding-tour/ar/{slug}.png
//   public/onboarding-tour/en/{slug}.png
//
// Usage (dev server must be running, db:seed:rich must have run first):
//
//   pnpm tour:screenshots
//
// Defaults to https://192.168.1.61:3000 — override with TOUR_BASE_URL.

import "dotenv/config";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import Redis from "ioredis";

const BASE_URL = process.env.TOUR_BASE_URL ?? "https://192.168.1.61:3000";
const LOGIN_EMAIL = process.env.TOUR_LOGIN_EMAIL ?? "amr@matgary.local";
const LOGIN_PASSWORD = process.env.TOUR_LOGIN_PASSWORD ?? "Test1234!";

const OUT_DIR = path.resolve(process.cwd(), "public/onboarding-tour");

// Same order as TOUR_SLIDES in OnboardingContent.tsx.
const SHOTS: Array<{ slug: string; path: string }> = [
  { slug: "dashboard", path: "/" },
  { slug: "inventory", path: "/inventory" },
  { slug: "add-product", path: "/add-product" },
  { slug: "sales", path: "/sales" },
  { slug: "customers", path: "/customers" },
  { slug: "reports", path: "/reports" },
  { slug: "purchases", path: "/purchases" },
  { slug: "suppliers", path: "/suppliers" },
  { slug: "tasks", path: "/tasks" },
  { slug: "expenses", path: "/expenses" },
  { slug: "team", path: "/team" },
  { slug: "activity", path: "/activity" },
  { slug: "settings", path: "/settings" },
];

/** Mirrors lib/cache.ts globalKey('userctx', userId) so we can DEL the same
 *  key the app set: `matgary:<env>:v1:g:userctx:<userId>`. */
function userContextRedisKey(userId: string): string {
  const env = process.env.NODE_ENV ?? "development";
  return `matgary:${env}:v1:g:userctx:${userId}`;
}

async function flipLocale(locale: "ar" | "en"): Promise<string> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  let userId: string;
  try {
    const rows = await sql<{ id: string }[]>`
      UPDATE users
         SET locale = ${locale},
             token_version = COALESCE(token_version, 0) + 1
       WHERE email = ${LOGIN_EMAIL}
       RETURNING id
    `;
    if (rows.length === 0) {
      throw new Error(
        `No user with email ${LOGIN_EMAIL} — run \`pnpm db:seed:rich\` first.`,
      );
    }
    userId = rows[0].id;
  } finally {
    await sql.end({ timeout: 2 });
  }

  // Best-effort cache bust. If redis is down the entry expires after
  // 60s anyway — we'd just see the wrong locale until then.
  if (process.env.REDIS_URL) {
    const redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    try {
      await redis.connect();
      // The bust uses a prefix scan internally, so DEL on the exact key
      // is enough. Match the cache module's prefix shape.
      const keys = await redis.keys(`${userContextRedisKey(userId)}*`);
      if (keys.length > 0) {
        await redis.del(keys);
      }
    } catch {
      // ignore — we'll fall back to TTL expiry
    } finally {
      await redis.quit().catch(() => {});
    }
  }

  return userId;
}

async function login(page: Page, localePrefix: "ar" | "en") {
  await page.goto(`${BASE_URL}/${localePrefix}/login`, {
    waitUntil: "domcontentloaded",
  });
  await page.fill('input[name="email"]', LOGIN_EMAIL);
  await page.fill('input[name="password"]', LOGIN_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function captureRun(
  context: BrowserContext,
  locale: "ar" | "en",
  outSubdir: string,
) {
  console.log(`\n── Capturing ${locale.toUpperCase()} → ${outSubdir} ──`);
  await flipLocale(locale);

  const page = await context.newPage();
  await login(page, locale);
  console.log(`  signed in, landed at ${page.url()}`);

  for (const shot of SHOTS) {
    const url = `${BASE_URL}${shot.path}`;
    console.log(`  ${locale}: ${shot.slug}  ←  ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.addStyleTag({
      content: `
        nextjs-portal,
        [data-next-mark-loading],
        [aria-label*="Next.js"] { display: none !important; }
      `,
    });
    await page.waitForTimeout(900);
    const out = path.join(outSubdir, `${shot.slug}.png`);
    await page.screenshot({ path: out, fullPage: false });
  }

  await page.close();
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set so we can flip users.locale");
  }
  const arDir = path.join(OUT_DIR, "ar");
  const enDir = path.join(OUT_DIR, "en");
  await mkdir(arDir, { recursive: true });
  await mkdir(enDir, { recursive: true });

  const browser = await chromium.launch();

  try {
    {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1600, height: 1000 },
        locale: "ar-EG",
        timezoneId: "Africa/Cairo",
        deviceScaleFactor: 2,
      });
      await captureRun(context, "ar", arDir);
      await context.close();
    }
    {
      // Fresh context = fresh cookie jar, so the new JWT comes through
      // without colliding with the AR session token.
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1600, height: 1000 },
        locale: "en-US",
        timezoneId: "Africa/Cairo",
        deviceScaleFactor: 2,
      });
      await captureRun(context, "en", enDir);
      await context.close();
    }
  } finally {
    // Always restore the user to Arabic so manual testing isn't disturbed.
    await flipLocale("ar");
    await browser.close();
  }

  console.log("");
  console.log(
    `✅ ${SHOTS.length} × 2 (ar + en) = ${SHOTS.length * 2} screenshots saved`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
