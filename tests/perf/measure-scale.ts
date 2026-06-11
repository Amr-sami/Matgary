// Per-tenant scale measurement. Logs in as each seeded tenant and runs
// the same scenario set against the production server. Captures latency
// per endpoint as the underlying tenant data grows.
//
// Usage:
//   BASE=http://localhost:3100 npx tsx tests/perf/measure-scale.ts
//
// Reads the three seed JSON files (or env vars) to know which tenants to
// hit. Logs in via the credentials API to mint a session cookie per
// tenant, then sequentially hits each endpoint N times.

import path from "node:path";
import fs from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const BASE = process.env.BASE ?? "http://localhost:3100";
const ITER = Number(process.env.ITER ?? 30);

// Manually maintained — populated from the seed-scale.ts output.
// Pass via env to override.
interface ScaleTarget {
  scale: string;
  cookieFile: string;
  productCount: number;
  saleCount: number;
}

function targetsFromEnv(): ScaleTarget[] {
  return [
    { scale: "p100",  cookieFile: "tests/perf/.cookies/p100.txt", productCount: 100,   saleCount: 500 },
    { scale: "p1k",   cookieFile: "tests/perf/.cookies/p1k.txt",  productCount: 1000,  saleCount: 5000 },
    { scale: "p10k",  cookieFile: "tests/perf/.cookies/p10k.txt", productCount: 10000, saleCount: 50000 },
  ];
}

interface Probe {
  label: string;
  path: string;
}

const PROBES: Probe[] = [
  { label: "products-list", path: "/api/products" },
  { label: "sales-list-paginated", path: "/api/sales?paginated=1&limit=50" },
  { label: "insights-overview", path: "/api/insights/overview" },
  { label: "branches", path: "/api/branches" },
  { label: "categories", path: "/api/categories" },
  { label: "dashboard-render", path: "/" },
];

interface ProbeResult {
  scale: string;
  label: string;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  errors: number;
  bodyBytes: number;
}

function pct(s: number[], p: number) {
  if (s.length === 0) return 0;
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

async function readCookie(cookieFile: string): Promise<string> {
  return (await fs.readFile(path.resolve(process.cwd(), cookieFile), "utf8")).trim();
}

async function measure(
  scale: string,
  cookie: string,
  probe: Probe,
): Promise<ProbeResult> {
  // warmup
  for (let i = 0; i < 3; i++) {
    try {
      await fetch(`${BASE}${probe.path}`, { headers: { Cookie: cookie } });
    } catch {
      /* */
    }
  }
  const samples: number[] = [];
  let errors = 0;
  let bodyBytes = 0;
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE}${probe.path}`, {
        headers: { Cookie: cookie },
      });
      const body = await res.text();
      const ms = performance.now() - t0;
      if (!res.ok) errors += 1;
      else bodyBytes = body.length;
      samples.push(ms);
    } catch {
      errors += 1;
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    scale,
    label: probe.label,
    p50: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    p99: pct(sorted, 0.99),
    mean: sum / Math.max(1, sorted.length),
    errors,
    bodyBytes,
  };
}

async function main() {
  const targets = targetsFromEnv();
  const allResults: ProbeResult[] = [];
  for (const target of targets) {
    // eslint-disable-next-line no-console
    console.log(`\n── ${target.scale} (${target.productCount} products, ${target.saleCount} sales) ──`);
    const cookie = await readCookie(target.cookieFile);
    // sanity check
    const sanity = await fetch(`${BASE}/api/branches`, {
      headers: { Cookie: cookie },
    });
    if (!sanity.ok) {
      // eslint-disable-next-line no-console
      console.error(`  auth failed: ${sanity.status}`);
      continue;
    }
    for (const probe of PROBES) {
      const r = await measure(target.scale, cookie, probe);
      allResults.push(r);
      // eslint-disable-next-line no-console
      console.log(
        `  ${r.label.padEnd(22)} p50=${r.p50.toFixed(1).padStart(7)}ms  p95=${r.p95.toFixed(1).padStart(7)}ms  p99=${r.p99.toFixed(1).padStart(7)}ms  body=${(r.bodyBytes / 1024).toFixed(1)}KB  err=${r.errors}`,
      );
    }
  }
  await fs.writeFile(
    path.resolve(process.cwd(), "tests/perf/scale-results.json"),
    JSON.stringify({ base: BASE, iter: ITER, results: allResults }, null, 2),
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
