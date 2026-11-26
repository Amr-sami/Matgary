// Concurrent load test rig. Drives autocannon against the production
// server at five concurrency levels, capturing latency + throughput + DB
// pool + Redis + Node resident memory + CPU at each step.
//
// Reuses the shared-owner storageState from the e2e safety net so every
// request is authenticated (no auth races).
//
// Output:
//   - per-scenario JSON dump at tests/perf/load/<scenario>-<conn>.json
//   - rolled-up summary printed at the end + tests/perf/load/summary.json

import autocannon from "autocannon";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const BASE = process.env.BASE ?? "http://localhost:3100";
const STATE_PATH = path.resolve(
  process.cwd(),
  "tests/e2e/.auth/shared-owner.json",
);
const OUT_DIR = path.resolve(process.cwd(), "tests/perf/load");
const CONNS = (process.env.CONNS ?? "10,25,50,100,250")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);
const DURATION_SEC = Number(process.env.DURATION ?? 15);

// One scenario per business-critical surface. Method + path + (for POSTs)
// fully-formed body. Pulled directly from PHASE_4 / PERFORMANCE_BASELINE
// "focus on POS sales, product lookup, customer lookup, dashboard, insights".
interface Scenario {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
  /** Skip if the surface is write-only and would corrupt state under load. */
  readOnly: boolean;
}

const SCENARIOS_BASE: Scenario[] = [
  {
    name: "products-list",
    method: "GET",
    path: "/api/products",
    readOnly: true,
  },
  {
    name: "sales-list",
    method: "GET",
    path: "/api/sales?paginated=1&limit=50",
    readOnly: true,
  },
  {
    name: "customer-lookup",
    method: "GET",
    path: `/api/customers/by-phone/${encodeURIComponent("+201001234567")}`,
    readOnly: true,
  },
  {
    name: "dashboard-render",
    method: "GET",
    path: "/",
    readOnly: true,
  },
  {
    name: "insights-overview",
    method: "GET",
    path: "/api/insights/overview",
    readOnly: true,
  },
  // POS sale path runs against a real product. Filled in at runtime once
  // we resolve a writable product id for the shared-owner tenant.
];

// Snapshot DB + Redis + process metrics at a given moment.
interface OpsSnapshot {
  ts: number;
  pg: {
    connections: number;
    active: number;
    idle_in_tx: number;
    idle: number;
  };
  redis: {
    instantaneous_ops_per_sec: number;
    connected_clients: number;
    used_memory_human: string;
  };
  node: {
    rss_mb: number;
    cpu_percent: number;
  };
}

function shell(cmd: string): string {
  return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function captureOps(): OpsSnapshot {
  // pg_stat_activity (no aggregation function here so we just parse what
  // psql -t returns line by line).
  const pgRaw = shell(
    `docker exec matgary-postgres psql -U matgary -d matgary -t -A -c "SELECT count(*), count(*) FILTER (WHERE state='active'), count(*) FILTER (WHERE state='idle in transaction'), count(*) FILTER (WHERE state='idle') FROM pg_stat_activity WHERE datname='matgary'"`,
  );
  const [c, a, iit, i] = pgRaw.split("|").map((v) => Number(v));

  // Redis INFO stats — grab a small subset.
  const ri = shell(`docker exec matgary-redis redis-cli INFO clients stats memory`);
  const find = (key: string) => {
    const m = ri.match(new RegExp(`^${key}:(\\S+)`, "m"));
    return m ? m[1] : "0";
  };

  // Node process — find the "next start" PID and grab its rss + %cpu.
  let rssMb = 0;
  let cpuPct = 0;
  try {
    const psLine = shell(
      `ps -axo pid,%cpu,rss,command | grep -E "next-server|next start" | grep -v grep | head -1`,
    );
    const parts = psLine.split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      cpuPct = Number(parts[1]);
      rssMb = Math.round(Number(parts[2]) / 1024);
    }
  } catch {
    /* ignore */
  }

  return {
    ts: Date.now(),
    pg: { connections: c, active: a, idle_in_tx: iit, idle: i },
    redis: {
      instantaneous_ops_per_sec: Number(find("instantaneous_ops_per_sec")),
      connected_clients: Number(find("connected_clients")),
      used_memory_human: find("used_memory_human"),
    },
    node: { rss_mb: rssMb, cpu_percent: cpuPct },
  };
}

async function ensureState(): Promise<{ cookieHeader: string }> {
  // Read the storage state Playwright saved. autocannon expects a
  // Cookie: header string, not a JSON file.
  const raw = await fs.readFile(STATE_PATH, "utf8");
  const state = JSON.parse(raw) as {
    cookies: Array<{ name: string; value: string; domain: string }>;
  };
  const cookieHeader = state.cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return { cookieHeader };
}

async function fetchOneProductId(cookieHeader: string): Promise<string | null> {
  // Find a real product id so the POS scenario hits a working path.
  const res = await fetch(`${BASE}/api/products`, {
    headers: { Cookie: cookieHeader },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data: Array<{ id: string; price: number; quantity: number }>;
  };
  // Need a product with enough stock for 100s of 1-unit sales. The shared
  // owner's seed creates "Casio MTP-1374L" with quantity=12 — fine for a
  // 15-second burst at low concurrency, may run out at 250 conns. We add
  // a stock top-up below.
  return json.data[0]?.id ?? null;
}

async function topUpProductStock(
  cookieHeader: string,
  productId: string,
): Promise<void> {
  // Adjust stock to a huge number so the POS scenario doesn't OOS mid-run.
  await fetch(`${BASE}/api/products/${productId}/adjust`, {
    method: "POST",
    headers: {
      Cookie: cookieHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ delta: 1_000_000, reason: "load-test top-up" }),
  });
}

interface ScenarioResult {
  name: string;
  connections: number;
  durationSec: number;
  requests_per_sec: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
  latency_max_ms: number;
  errors: number;
  timeouts: number;
  non_2xx: number;
  ops_before: OpsSnapshot;
  ops_after: OpsSnapshot;
  ops_peak: OpsSnapshot;
}

async function runScenario(
  scenario: Scenario,
  connections: number,
  cookieHeader: string,
): Promise<ScenarioResult> {
  const opsBefore = captureOps();
  // Snapshot peak ops every 1 s during the run.
  let opsPeak: OpsSnapshot = opsBefore;
  const interval = setInterval(() => {
    try {
      const cur = captureOps();
      if (
        cur.pg.connections > opsPeak.pg.connections ||
        cur.node.cpu_percent > opsPeak.node.cpu_percent ||
        cur.node.rss_mb > opsPeak.node.rss_mb ||
        cur.redis.instantaneous_ops_per_sec >
          opsPeak.redis.instantaneous_ops_per_sec
      ) {
        opsPeak = cur;
      }
    } catch {
      /* docker exec races during shutdown */
    }
  }, 1_000);

  const headers: Record<string, string> = { Cookie: cookieHeader };
  if (scenario.method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const result = await autocannon({
    url: `${BASE}${scenario.path}`,
    connections,
    duration: DURATION_SEC,
    method: scenario.method,
    body: scenario.body,
    headers,
    // Default timeout is 10s — keep generous to surface real latency under
    // contention rather than turning slow requests into timeouts.
    timeout: 30,
  });

  clearInterval(interval);
  const opsAfter = captureOps();

  return {
    name: scenario.name,
    connections,
    durationSec: DURATION_SEC,
    requests_per_sec: result.requests.average,
    latency_p50_ms: result.latency.p50,
    latency_p95_ms: result.latency.p97_5,
    latency_p99_ms: result.latency.p99,
    latency_max_ms: result.latency.max,
    errors: result.errors,
    timeouts: result.timeouts,
    non_2xx: result.non2xx,
    ops_before: opsBefore,
    ops_after: opsAfter,
    ops_peak: opsPeak,
  };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    `Load test\nBASE=${BASE}\nCONNS=${CONNS.join(",")}\nDURATION=${DURATION_SEC}s`,
  );
  await fs.mkdir(OUT_DIR, { recursive: true });

  const { cookieHeader } = await ensureState();
  const productId = await fetchOneProductId(cookieHeader);
  if (productId) {
    await topUpProductStock(cookieHeader, productId);
  }

  // Compose the full scenario list — POS write path needs a real productId.
  const scenarios: Scenario[] = [
    ...SCENARIOS_BASE,
    ...(productId
      ? [
          {
            name: "pos-cart-sale",
            method: "POST" as const,
            path: "/api/sales/cart",
            body: JSON.stringify({
              lines: [{ productId, quantity: 1, pricePerUnit: 1 }],
              options: { paymentMethod: "cash" as const },
            }),
            readOnly: false,
          },
        ]
      : []),
  ];

  const all: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    for (const conns of CONNS) {
      // eslint-disable-next-line no-console
      console.log(
        `\n── ${scenario.name} @ ${conns} connections (${DURATION_SEC}s) ──`,
      );
      const t0 = performance.now();
      const r = await runScenario(scenario, conns, cookieHeader);
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      all.push(r);
      // eslint-disable-next-line no-console
      console.log(
        `  ${r.requests_per_sec.toFixed(0).padStart(5)} req/s  p50=${r.latency_p50_ms.toFixed(0).padStart(4)}ms  p95=${r.latency_p95_ms.toFixed(0).padStart(4)}ms  p99=${r.latency_p99_ms.toFixed(0).padStart(4)}ms  max=${r.latency_max_ms.toFixed(0).padStart(5)}ms` +
          `  err=${r.errors}  to=${r.timeouts}  non2xx=${r.non_2xx}` +
          `  pg(peak)=${r.ops_peak.pg.connections}c/${r.ops_peak.pg.active}a` +
          `  redis=${r.ops_peak.redis.instantaneous_ops_per_sec}ops` +
          `  node=${r.ops_peak.node.rss_mb}MB ${r.ops_peak.node.cpu_percent.toFixed(0)}%cpu` +
          `  ${elapsed}s`,
      );
      // Dump individual result.
      await fs.writeFile(
        path.join(OUT_DIR, `${r.name}-c${conns}.json`),
        JSON.stringify(r, null, 2),
      );
      // Brief breather between scenarios so the pool drains.
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  await fs.writeFile(
    path.join(OUT_DIR, "summary.json"),
    JSON.stringify({ base: BASE, connsLevels: CONNS, durationSec: DURATION_SEC, results: all }, null, 2),
  );
  // eslint-disable-next-line no-console
  console.log(`\nDumped per-scenario JSON + summary to ${OUT_DIR}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
