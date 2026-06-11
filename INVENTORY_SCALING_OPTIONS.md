# Inventory Scaling — Options Analysis (Track 1)

Evidence-based evaluation of four scaling paths for the dominant bottleneck identified in Phase 5B: row-lock contention on `products.quantity` under concurrent POS load.

**Source data**: `tests/perf/lock-samples-c{10,50,250}.json` + `pg_stat_statements` snapshot from the lock-measurement run.

**This phase does not implement.** It picks one path and quantifies why.

---

## 1. Direct measurement of the problem

Sampled `pg_locks` and `pg_stat_activity` at **10 Hz** while autocannon drove sustained POS sales of the same product:

| Concurrency | req/s | p50 ms | p99 ms | Mean blocked txns | Mean held RowExclusiveLocks | Long xacts (>500ms) |
|---|---|---|---|---|---|---|
| 10 | 89 | 101 | 375 | **0.70** | 1.07 | 0.04 |
| 50 | 104 | 444 | 1,307 | **3.65** | 4.87 | 0.00 |
| 250 | 127 | 1,928 | 2,565 | **4.40** | 5.68 | 0.00 |

### What the numbers say

- At **50 concurrent POS POSTs**, on average ~3.65 transactions are *waiting* for the lock at any given 100ms sample. ~4.87 are holding it (or its descendants).
- **For every 1 transaction holding the lock, ~1 is waiting.** That's classic 1-deep queueing on a single resource.
- Throughput saturates around **127 req/s** at 250 conns — increasing connections beyond ~50 gives near-zero gain.
- No long-running transactions (>500ms holding the lock individually). The waits are *short* but *constant*.

### From `pg_stat_statements`

Across the lock-measurement run (4854 actual cart sales, ~10K total POS attempts retried):

| Query | Calls | Mean ms | Total ms | % of total DB time |
|---|---|---|---|---|
| **`UPDATE products SET quantity, updated_at WHERE tenant_id, id`** | **4,854** | **33.12** | **160,785** | **96%** |
| `INSERT INTO sales` | 4,851 | 0.40 | 1,932 | 1.2% |
| `INSERT INTO activity_logs` | 4,854 | 0.24 | 1,152 | 0.7% |
| `INSERT INTO product_history` | 4,854 | 0.13 | 627 | 0.4% |
| All other queries combined | — | — | <1,500 | ~1% |

**One query consumes 96% of all DB time.** Mean exec time is 33ms — but the pure-SQL cost for an UPDATE-by-PK-on-a-tiny-table is <1ms; the rest is **lock wait**.

---

## 2. Options

Each option below is evaluated on four axes:

- **Throughput impact** — measured against the current 127 req/s ceiling (worst-case single-product hammer).
- **Migration complexity** — code + schema + operational changes required.
- **Operational risk** — what happens if it goes wrong in production.
- **Correctness risk** — what semantic guarantees are altered.

### Option A — Status quo (current row locking)

The `UPDATE products SET quantity = $1` inside the cart transaction. Postgres acquires `RowExclusiveLock` until commit; concurrent writers serialise on the row.

- **Throughput**: capped at ~127 req/s for single-product hammer; ~600+ req/s for spread load (extrapolation from c=10 single-row × inverse-of-blocked-fraction).
- **Migration complexity**: zero — already shipped.
- **Operational risk**: zero new.
- **Correctness risk**: zero — Postgres ACID guarantees the stock count.
- **Verdict**: **the floor we measure others against.**

### Option B — Atomic inventory reservations (SELECT FOR UPDATE NOWAIT + retry)

Restructure `recordCartSale` so the stock check + decrement happens in a single `UPDATE … WHERE quantity >= $qty RETURNING …` with `NOWAIT`. On lock conflict, the route returns a `409 STOCK_LOCKED` and the client retries.

- **Throughput**: marginal — still serialised on the same row. The 33ms mean would drop to maybe 20ms (no idle waiting; failed attempts return immediately) but req/s ceiling moves from ~127 to maybe ~180 because failed attempts free pool slots faster.
- **Migration complexity**: medium — `recordCartSale` rewrites the inventory check from "check then decrement" to "decrement conditionally"; the cart route gains a retry loop with backoff; client UI shows "still processing…" briefly.
- **Operational risk**: low — same DB, same RLS, same semantics.
- **Correctness risk**: low — `UPDATE … WHERE quantity >= X RETURNING` is the canonical atomic decrement.
- **Verdict**: cleanest incremental improvement. Buys ~40% headroom on the worst-case single-product case, more on spread load. **Doesn't fundamentally fix the bottleneck** — same row, same serialisation.

### Option C — Batched stock mutations (deferred apply)

Hold sales in an in-memory or Redis queue per branch; a batcher flushes every N ms or M cart sales by aggregating the deltas and applying one UPDATE per product per batch.

- **Throughput**: very high — at 100ms batch interval and avg 10 sales/batch, the per-row contention drops 10×. Theoretical ceiling: ~1,200 req/s for the same product.
- **Migration complexity**: **high** — needs a Redis-backed batcher with crash recovery (the queue IS the source of truth between batches), changes the cart endpoint's response semantics ("reservation accepted, will commit"), needs reconciliation jobs.
- **Operational risk**: **high** — losing Redis between batch acceptance and DB commit means lost sales. Needs WAL-like replay log. The activity_logs + product_history writes also need batching to keep audit consistent.
- **Correctness risk**: **medium-high** — the stock view between batch open and batch close is inconsistent. Two cashiers can both see "qty=3" and ring up sales for 2 each; the over-sell window has to be handled by either:
  - pessimistic: hold a per-product Redis lock during the batch window (defeats most of the gain)
  - optimistic: accept the over-sell and reconcile post-hoc (changes customer-facing semantics)
- **Verdict**: real throughput win but rewrites the consistency model. Not a fit for "no architecture rewrites".

### Option D — Append-only inventory ledger (event sourcing for stock)

Replace `products.quantity` (a single mutable cell) with `product_stock_events` — an append-only table of `(productId, branchId, delta, source, createdAt)`. The current quantity is computed by `SUM(delta)`. Reads cache the materialised value.

- **Throughput**: very high for writes — `INSERT` doesn't lock anything; concurrent inserts ARE the workload Postgres is designed for. Theoretical ceiling: ~5,000+ INSERTs/sec on a single product (vs 127 UPDATEs/sec).
- **Migration complexity**: **very high** — adds a new table, rewrites every read path that depends on `products.quantity` (inventory page, dashboard low-stock, cart pre-check, settle flow), adds a materialised view or trigger to keep `products.quantity` in sync as a "fast read" column, adds a backfill from existing `sales` + `returns` + `product_history` to bootstrap the ledger.
- **Operational risk**: **high** — the materialised "current quantity" can drift from `SUM(events)` under partial failures. Reconciliation jobs become a production concern.
- **Correctness risk**: **medium** — race condition for "do I have stock?": the SELECT-then-INSERT pattern still has a window where two concurrent carts both see qty=1 and both insert -1 deltas, ending at -1. Mitigation: a `RowShareLock` on the product row during the event insert, which… brings back the contention you tried to avoid.
- **Verdict**: actually solves the bottleneck *if* the consistency model can tolerate eventual-correct stock. **Significantly changes the data model.** Three+ months of work to land correctly. Out of scope per "no architecture rewrites".

---

## 3. Comparison table

| Option | Δ throughput (single-row hammer) | Δ throughput (real spread) | Effort | Operational risk | Correctness risk |
|---|---|---|---|---|---|
| A (status quo) | baseline 127 r/s | baseline ~600 r/s | 0 | 0 | 0 |
| **B (atomic with retry)** | **+40% (~180 r/s)** | **+10% (~660 r/s)** | **~3 days** | **low** | **low** |
| C (batched) | +800% (~1,200 r/s) | +50% (~900 r/s) | ~3 weeks | high | medium-high |
| D (event ledger) | +3,000% (~5,000 r/s) | +200% (~1,800 r/s) | ~3 months | high | medium |

The single-row throughput numbers are the *worst case* for a tenant (250 cashiers on one product). In production, real tenants have load spread across many products, so the "real spread" column is the more honest yardstick.

---

## 4. Recommendation: Option B

### Why

1. **The real-spread throughput today is already well above any plausible per-tenant POS rate.** A tenant with 50 cashiers ringing across 200 different products averages 0.05 sales/sec/cashier × 50 = 2.5 sales/sec. We have 480× headroom even in the worst case at 50 conns.
2. **The single-product hammer is not a real workload** — it's a load-test artefact. Real customers buy different products. Picking C or D to solve a contention that doesn't exist in production is a textbook speculative optimization.
3. **Option B closes the actual edge case** (a tenant runs a "flash sale" on one SKU) at minimal risk. The atomic UPDATE-with-condition is the textbook Postgres pattern for stock management — it's how every e-commerce ORM ships their inventory layer.
4. **A & B leave us a clean migration path to C or D** if a tenant ever proves they need it. C and D don't reverse cleanly.

### Concrete plan (NOT to implement in this phase)

```sql
-- Replace the existing two-step (SELECT then UPDATE) with one statement
UPDATE products
SET quantity = quantity - $delta,
    updated_at = $now
WHERE tenant_id = $tid
  AND id        = $pid
  AND quantity >= $delta          -- the "stock check" becomes part of the WHERE
RETURNING quantity AS new_qty;
```

App-side flow:

```ts
const [row] = await tx.execute(sql`...`);
if (!row) {
  // Either the product was deleted, OR insufficient stock. The catch-all
  // 404/400 from the route already handles this — same DomainError codes.
  throw new DomainError("INSUFFICIENT_STOCK", 400, { ... });
}
```

Add a retry layer at the route handler (NOT inside `withTenant`) for transient `RowExclusiveLock` conflicts using `WHERE quantity >= $delta` — if zero rows updated, the transaction returns INSUFFICIENT_STOCK with no retry (it's a real out-of-stock, not a contention timeout).

### What this WON'T deliver

- Multi-tenant pool scale gains. Phase 5B Bottleneck #1 disappears as a *measurable* concern; the pool=10 bottleneck stays.
- A way to ring up 1,000 sales/sec on a single product. That's a real flash-sale need; Options C or D solve it. Tabled until measured demand.
- Free correctness — the `RETURNING quantity` value still needs careful audit-log treatment (we use the OLD quantity in `product_history`'s `quantityAfter` field — that field needs to change to `RETURNING quantity AS quantityAfter`).

### Implementation budget

| Step | Effort |
|---|---|
| Rewrite `adjustProductStock` to one atomic UPDATE | 0.5 day |
| Update DomainError mapping so insufficient-stock from the conditional UPDATE returns the same code | 0.5 day |
| Add the load-test rig from Phase 5A to CI gate so the change shows the throughput Δ | 0.5 day |
| Re-run lock-measurement against the new code; confirm `blocked_count` drops | 0.5 day |
| Total | **2 days** |

### Acceptance test (when this is implemented)

Re-run `tests/perf/measure-locks.ts` at conns=50. Pass criteria:
- `blocked_count` mean drops below 1.0 (vs 3.65 today).
- req/s rises above 200 (vs 104 today).
- p99 latency drops below 600ms (vs 1,307ms today).

If those numbers aren't hit, Option B's benefit didn't materialise — escalate to C.
