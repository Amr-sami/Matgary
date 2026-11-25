// Daily low-stock sweep.
//
// External scheduler calls this hourly. For each non-suspended tenant we fire
// one `inventory.low_stock` per currently-below-threshold product, exactly
// once per calendar day in the tenant's timezone. Dedupe is link-based:
//
//   link = `/inventory/<productId>?lowStock=YYYY-MM-DD`
//
// A tenant that flipped a product in and out of the alert band in the same
// day gets one notification; the next day's sweep fires a fresh one if the
// product is still low. Owner-only (role gate inside fanoutEvent).

import { NextRequest, NextResponse } from "next/server";
import { and, eq, lte, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { products, tenants } from "@/lib/db/schema";
import { guardCronRequest } from "@/lib/cron/auth";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { listOwnerUserIds, wasAlreadyDispatched } from "@/lib/notifications/dedupe";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `YYYY-MM-DD` in the tenant's local date. */
async function localDate(tz: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    select (now() at time zone ${tz})::date::text as date
  `)) as unknown as { date: string }[] | { rows: { date: string }[] };
  const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0];
  return row?.date ?? null;
}

export async function POST(req: NextRequest) {
  const blocked = await guardCronRequest(req, { bucket: "cron.low_stock_sweep" });
  if (blocked) return blocked;

  const tenantRows = await db
    .select({ id: tenants.id, tz: tenants.timezone })
    .from(tenants)
    .where(sql`${tenants.suspendedAt} IS NULL`);

  let fanned = 0;
  let deduped = 0;
  let failed = 0;

  for (const t of tenantRows) {
    try {
      const date = await localDate(t.tz);
      if (!date) continue;
      // Period boundary for dedupe: midnight local, best-approximated as
      // UTC start-of-day of the same `YYYY-MM-DD`. A tiny window of
      // overlap at the TZ boundary is acceptable (we'd rather over-dedupe
      // than double-buzz the owner).
      const since = new Date(`${date}T00:00:00.000Z`);

      const owners = await listOwnerUserIds(t.id);
      if (owners.length === 0) continue;

      // `products` is RLS-scoped — this read must run inside withTenant.
      const low = await withTenant(t.id, (tx) =>
        tx
          .select({
            id: products.id,
            name: products.name,
            quantity: products.quantity,
            threshold: products.lowStockThreshold,
          })
          .from(products)
          .where(
            and(
              eq(products.tenantId, t.id),
              lte(products.quantity, products.lowStockThreshold),
            ),
          ),
      );
      if (low.length === 0) continue;

      for (const p of low) {
        const link = `/inventory/${p.id}?lowStock=${date}`;
        // One recipient is enough to decide — all owners share the dedupe
        // bucket (one notification row per owner, one dispatch per product
        // per day).
        const already = await wasAlreadyDispatched({
          tenantId: t.id,
          userId: owners[0]!,
          kind: "low_stock",
          link,
          since,
        });
        if (already) {
          deduped += 1;
          continue;
        }
        await fanoutEvent(t.id, null, "inventory.low_stock", {
          productName: p.name,
          remainingQty: p.quantity,
          threshold: p.threshold,
          link,
        });
        fanned += 1;
      }
    } catch (err) {
      failed += 1;
      logger.error({
        event: "cron.low_stock_sweep.tenant_failed",
        tenantId: t.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ tenants: tenantRows.length, fanned, deduped, failed });
}
