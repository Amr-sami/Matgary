// Track 1 — POS inventory lock-wait measurement.
//
// Drives sustained concurrent POS sales against the shared-owner tenant's
// single product (same as the Phase 5A scenario) while sampling pg_locks
// every 100 ms. The sampler records:
//   - count of pending lock waits
//   - count of granted locks on the products row
//   - mode (RowExclusiveLock vs RowShareLock)
//
// Output: tests/perf/lock-samples.json — array of {ts, blocked, granted, queryWaitingFor}
//
// Run alongside autocannon load — this script does the autocannon part too.

import autocannon from "autocannon";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const BASE = process.env.BASE ?? "http://localhost:3100";
const STATE_PATH = path.resolve(process.cwd(), "tests/e2e/.auth/shared-owner.json");
const CONNS = Number(process.env.CONNS ?? 50);
const DURATION = Number(process.env.DURATION ?? 15);

interface LockSample {
  ts: number;
  blocked_count: number;
  granted_row_exclusive: number;
  active_xacts: number;
  long_xacts: number;
  blocking_query?: string;
  waiting_query?: string;
}

function sample(): LockSample {
  // One round-trip to docker exec per sample is the bottleneck of this
  // sampler — keep the SQL tight.
  const raw = execSync(
    `docker exec matgary-postgres psql -U matgary -d matgary -tA -F'|' -c "
      WITH
      blocked AS (
        SELECT count(*) AS n FROM pg_locks WHERE NOT granted
      ),
      gre AS (
        SELECT count(*) AS n FROM pg_locks
        WHERE granted AND mode = 'RowExclusiveLock'
          AND relation = (SELECT oid FROM pg_class WHERE relname = 'products')
      ),
      active AS (
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE state IN ('active','idle in transaction')
          AND datname='matgary'
      ),
      long_x AS (
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE state IN ('active','idle in transaction')
          AND datname='matgary'
          AND now() - xact_start > interval '500ms'
      )
      SELECT
        (SELECT n FROM blocked),
        (SELECT n FROM gre),
        (SELECT n FROM active),
        (SELECT n FROM long_x);"`,
    { stdio: ["ignore", "pipe", "ignore"] },
  )
    .toString()
    .trim();
  const [b, g, a, l] = raw.split("|").map(Number);
  return {
    ts: Date.now(),
    blocked_count: b,
    granted_row_exclusive: g,
    active_xacts: a,
    long_xacts: l,
  };
}

async function fetchProductId(cookie: string): Promise<string> {
  const r = await fetch(`${BASE}/api/products`, { headers: { Cookie: cookie } });
  const j = (await r.json()) as { data: Array<{ id: string }> };
  return j.data[0]!.id;
}

async function main() {
  const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as {
    cookies: Array<{ name: string; value: string }>;
  };
  const cookieHeader = state.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const productId = await fetchProductId(cookieHeader);
  // Top up stock so we don't run out during the burst.
  await fetch(`${BASE}/api/products/${productId}/adjust`, {
    method: "POST",
    headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ delta: 100_000, reason: "lock-measure" }),
  });

  const samples: LockSample[] = [];
  const sampler = setInterval(() => {
    try {
      samples.push(sample());
    } catch {
      /* ignore brief failures */
    }
  }, 100);

  // eslint-disable-next-line no-console
  console.log(`Driving ${CONNS} concurrent POS POSTs for ${DURATION}s while sampling pg_locks @ 10Hz`);
  const result = await autocannon({
    url: `${BASE}/api/sales/cart`,
    connections: CONNS,
    duration: DURATION,
    method: "POST",
    body: JSON.stringify({
      lines: [{ productId, quantity: 1, pricePerUnit: 1 }],
      options: { paymentMethod: "cash" },
    }),
    headers: {
      Cookie: cookieHeader,
      "Content-Type": "application/json",
    },
    timeout: 30,
  });
  clearInterval(sampler);

  // Per-iteration summary.
  const blocked = samples.map((s) => s.blocked_count);
  const granted = samples.map((s) => s.granted_row_exclusive);
  const longx = samples.map((s) => s.long_xacts);
  const max = (a: number[]) => a.reduce((m, v) => (v > m ? v : m), 0);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

  // eslint-disable-next-line no-console
  console.log(
    `\n  req/s=${result.requests.average.toFixed(0)}  p50=${result.latency.p50}ms  p99=${result.latency.p99}ms` +
    `\n  pg samples taken: ${samples.length}` +
    `\n  blocked_lock_waiters       max=${max(blocked)}   mean=${mean(blocked).toFixed(2)}` +
    `\n  granted RowExclusiveLock   max=${max(granted)}   mean=${mean(granted).toFixed(2)}` +
    `\n  long_xacts (>500ms)        max=${max(longx)}   mean=${mean(longx).toFixed(2)}`,
  );

  await fs.writeFile(
    path.resolve(process.cwd(), "tests/perf/lock-samples.json"),
    JSON.stringify({
      conns: CONNS,
      durationSec: DURATION,
      autocannon: {
        rps: result.requests.average,
        p50: result.latency.p50,
        p95: result.latency.p97_5,
        p99: result.latency.p99,
        non2xx: result.non2xx,
      },
      samples,
    }, null, 2),
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
