// Page TTFB + payload size, authenticated. Uses the same storageState as
// measure-baseline.ts. Captures the size of the SSR HTML payload as a
// proxy for "what the browser has to chew" before first interactive paint.

import { chromium } from "@playwright/test";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs/promises";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const BASE = process.env.BASE ?? "http://localhost:3100";
const ITER = Number(process.env.ITER ?? 10);
const STATE_PATH = path.resolve(
  process.cwd(),
  "tests/e2e/.auth/shared-owner.json",
);

interface PageProbe {
  route: string;
}

const PAGES: PageProbe[] = [
  { route: "/" },
  { route: "/sales" },
  { route: "/inventory" },
  { route: "/customers" },
  { route: "/insights" },
  { route: "/settings" },
  { route: "/purchases" },
  { route: "/team" },
  { route: "/tasks" },
  { route: "/expenses" },
];

interface PageResult {
  route: string;
  /** Time from goto() until the response is "committed" — first byte
   *  arrives. Streaming SCs hit this fast; the old client-rendered pages
   *  also hit it fast (they were never the bottleneck). */
  firstByte_p50: number;
  firstByte_p95: number;
  /** Time until DOMContentLoaded — for streaming pages, this includes
   *  every chunk Suspense flushes. For the old CC pages it's basically
   *  the same as first-byte (skeleton DOM, no data). */
  ttfb_p50: number;
  ttfb_p95: number;
  total_p50: number;
  total_p95: number;
  bodyBytes: number;
  status: number;
  errors: number;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

async function main(): Promise<void> {
  let stateExists = false;
  try {
    await fs.access(STATE_PATH);
    stateExists = true;
  } catch {
    /* none */
  }
  if (!stateExists) {
    console.error("[measure-pages] no shared state — run e2e tests first");
    process.exit(2);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: STATE_PATH });
  const page = await ctx.newPage();

  const rows: PageResult[] = [];

  for (const probe of PAGES) {
    // warm-up
    for (let i = 0; i < 2; i++) {
      try {
        await page.goto(`${BASE}${probe.route}`, {
          waitUntil: "commit",
        });
      } catch {
        /* warmup */
      }
    }
    const firstBytes: number[] = [];
    const ttfbs: number[] = [];
    const totals: number[] = [];
    let bodyBytes = 0;
    let status = 0;
    let errors = 0;
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      try {
        // Two-stage measurement so streaming SCs are fair: `commit` fires
        // on first byte (~response header), `domcontentloaded` fires when
        // the full streamed HTML has arrived.
        const commitResp = await page.goto(`${BASE}${probe.route}`, {
          waitUntil: "commit",
          timeout: 30_000,
        });
        const t_first = performance.now();
        await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
        const t1 = performance.now();
        const body = await commitResp?.body();
        const t2 = performance.now();
        status = commitResp?.status() ?? 0;
        bodyBytes = body?.length ?? 0;
        firstBytes.push(t_first - t0);
        ttfbs.push(t1 - t0);
        totals.push(t2 - t0);
      } catch {
        errors += 1;
      }
    }
    const fbSorted = [...firstBytes].sort((a, b) => a - b);
    const tSorted = [...ttfbs].sort((a, b) => a - b);
    const totSorted = [...totals].sort((a, b) => a - b);
    const result: PageResult = {
      route: probe.route,
      firstByte_p50: pct(fbSorted, 0.5),
      firstByte_p95: pct(fbSorted, 0.95),
      ttfb_p50: pct(tSorted, 0.5),
      ttfb_p95: pct(tSorted, 0.95),
      total_p50: pct(totSorted, 0.5),
      total_p95: pct(totSorted, 0.95),
      bodyBytes,
      status,
      errors,
    };
    rows.push(result);
    console.log(
      `${probe.route.padEnd(14)} status=${status}  first p50=${result.firstByte_p50.toFixed(0).padStart(4)}ms p95=${result.firstByte_p95.toFixed(0).padStart(4)}ms  dom p50=${result.ttfb_p50.toFixed(0).padStart(4)}ms p95=${result.ttfb_p95.toFixed(0).padStart(4)}ms  total p50=${result.total_p50.toFixed(0).padStart(4)}ms p95=${result.total_p95.toFixed(0).padStart(4)}ms  html=${(bodyBytes / 1024).toFixed(1)}KB`,
    );
  }

  await browser.close();
  await fs.writeFile(
    path.resolve(process.cwd(), "tests/perf/pages-baseline.json"),
    JSON.stringify({ base: BASE, iter: ITER, rows }, null, 2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
