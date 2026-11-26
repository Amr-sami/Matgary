// Performance baseline probe. Uses the shared-owner storageState the e2e
// safety net already provisions, so it's authenticated for every tenant
// route without a manual cookie dance.
//
// Output: per-endpoint p50/p95/p99 + mean (server-measured, including
// network on localhost).

import { request } from "@playwright/test";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs/promises";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const BASE = process.env.BASE ?? "http://localhost:3100";
const ITER = Number(process.env.ITER ?? 30);
const STATE_PATH = path.resolve(
  process.cwd(),
  "tests/e2e/.auth/shared-owner.json",
);

interface Probe {
  label: string;
  method: "GET" | "POST";
  url: string;
  data?: unknown;
}

const PROBES: Probe[] = [
  // Public + cheap
  { label: "GET /healthz", method: "GET", url: "/healthz" },
  { label: "GET /readyz", method: "GET", url: "/readyz" },
  { label: "GET /api/plans", method: "GET", url: "/api/plans" },
  // Authenticated reads (hot paths)
  { label: "GET /api/branches", method: "GET", url: "/api/branches" },
  { label: "GET /api/products", method: "GET", url: "/api/products" },
  { label: "GET /api/sales (legacy)", method: "GET", url: "/api/sales" },
  {
    label: "GET /api/sales?paginated=1",
    method: "GET",
    url: "/api/sales?paginated=1&limit=50",
  },
  { label: "GET /api/categories", method: "GET", url: "/api/categories" },
  {
    label: "GET /api/customers/by-phone",
    method: "GET",
    url: "/api/customers/by-phone/%2B201001234567",
  },
  {
    label: "GET /api/insights/overview",
    method: "GET",
    url: "/api/insights/overview",
  },
  { label: "GET /api/expenses", method: "GET", url: "/api/expenses" },
  { label: "GET /api/returns", method: "GET", url: "/api/returns" },
  { label: "GET /api/team", method: "GET", url: "/api/team" },
  { label: "GET /api/notifications", method: "GET", url: "/api/notifications" },
  { label: "GET /api/activity", method: "GET", url: "/api/activity" },
  { label: "GET /api/settings", method: "GET", url: "/api/settings" },
];

interface ProbeResult {
  label: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  errors: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

async function measure(
  ctx: import("@playwright/test").APIRequestContext,
  probe: Probe,
): Promise<ProbeResult> {
  const samples: number[] = [];
  let errors = 0;
  // Warm-up — first hit pays JIT + cache miss costs we don't want in the
  // p50.
  for (let i = 0; i < 3; i++) {
    try {
      await ctx.fetch(`${BASE}${probe.url}`, { method: probe.method });
    } catch {
      /* ignore warmup errors */
    }
  }
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    try {
      const res = await ctx.fetch(`${BASE}${probe.url}`, {
        method: probe.method,
      });
      const ms = performance.now() - t0;
      if (!res.ok() && res.status() !== 401) {
        errors += 1;
      }
      samples.push(ms);
    } catch {
      errors += 1;
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    label: probe.label,
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean: sum / Math.max(1, sorted.length),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    errors,
  };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    `Performance baseline\nBASE=${BASE}\nITER=${ITER}\nstate=${STATE_PATH}\n`,
  );

  let stateExists = false;
  try {
    await fs.access(STATE_PATH);
    stateExists = true;
  } catch {
    /* no state */
  }

  const ctx = stateExists
    ? await request.newContext({ storageState: STATE_PATH })
    : await request.newContext();

  const rows: ProbeResult[] = [];
  for (const p of PROBES) {
    const r = await measure(ctx, p);
    rows.push(r);
    // eslint-disable-next-line no-console
    console.log(
      `${p.label.padEnd(38)} p50=${r.p50.toFixed(1).padStart(7)}ms  p95=${r.p95
        .toFixed(1)
        .padStart(7)}ms  p99=${r.p99
        .toFixed(1)
        .padStart(7)}ms  mean=${r.mean
        .toFixed(1)
        .padStart(7)}ms  min=${r.min.toFixed(1).padStart(5)}ms max=${r.max
        .toFixed(1)
        .padStart(5)}ms  err=${r.errors}`,
    );
  }
  await ctx.dispose();

  // Dump JSON for the doc
  const out = path.resolve(process.cwd(), "tests/perf/baseline.json");
  await fs.writeFile(out, JSON.stringify({ base: BASE, iter: ITER, rows }, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nWrote: ${out}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
