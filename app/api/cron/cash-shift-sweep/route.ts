import { NextRequest, NextResponse } from "next/server";
import { db, withTenant } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { tenants, tenantMembers } from "@/lib/db/schema";
import { guardCronRequest } from "@/lib/cron/auth";
import { logActivity } from "@/lib/repo/activity";
import {
  closeShift,
  computeShiftCashFlow,
  listAutoCloseCandidates,
  listStaleOpenShifts,
} from "@/lib/repo/cash-shifts";
import { createNotification } from "@/lib/repo/notifications";

// Hourly sweep, two jobs:
//   1. Auto-close owner-desk shifts whose business day has rolled past
//      (cut at "yesterday" in the tenant's timezone). These shifts only
//      exist so cash sales from the owner aren't blocked; they're not
//      real drawers and don't need a count.
//   2. Notify every manager when a real shift has been open > 24 h. The
//      notification re-fires hourly until force-closed so the owner
//      can't miss it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const blocked = await guardCronRequest(req, { bucket: "cron.cash_shift_sweep" });
  if (blocked) return blocked;

  // Spec 03: skip suspended tenants — no auto-close, no notifications.
  const tenantRows = await db
    .select({ id: tenants.id, tz: tenants.timezone })
    .from(tenants)
    .where(sql`${tenants.suspendedAt} IS NULL`);

  let autoClosed = 0;
  let staleNotified = 0;
  let failures = 0;
  const staleCutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const staleCutoff = new Date(staleCutoffMs);

  for (const t of tenantRows) {
    try {
      // ── 1. Owner-desk auto-close ──────────────────────────────────────
      // Cutoff = local midnight today in the tenant's tz, as a UTC instant.
      // Postgres handles the tz arithmetic so we don't pull in date-fns-tz.
      const cutoffRows = (await db.execute(sql`
        select (date_trunc('day', now() at time zone ${t.tz}) at time zone ${t.tz})::timestamptz as cutoff
      `)) as unknown as { cutoff: string }[] | { rows: { cutoff: string }[] };
      const cutoffStr = Array.isArray(cutoffRows)
        ? cutoffRows[0]?.cutoff
        : cutoffRows?.rows?.[0]?.cutoff;
      const cutoff = cutoffStr ? new Date(cutoffStr) : staleCutoff;

      const candidates = await listAutoCloseCandidates(t.id, cutoff);
      for (const c of candidates) {
        try {
          // Use the expected cash as the counted value so variance = 0.
          // Owner-desk shifts are bookkeeping containers; they never have a
          // physical drawer to count.
          const flow = await computeShiftCashFlow(t.id, c.id);
          await closeShift(t.id, {
            shiftId: c.id,
            closedByUserId: c.cashierUserId,
            countedCash: flow.expectedCash,
            closingNote: "auto-closed (owner desk)",
            closeReason: "auto_midnight",
          });
          autoClosed += 1;
        } catch (e) {
          failures += 1;
          console.error(
            `[cron/cash-shift-sweep] auto-close ${c.id} failed:`,
            e instanceof Error ? e.message : e,
          );
        }
      }

      // ── 2. Stale real shifts ──────────────────────────────────────────
      const stale = await listStaleOpenShifts(t.id, staleCutoff);
      if (stale.length > 0) {
        const members = await db
          .select({
            userId: tenantMembers.userId,
            role: tenantMembers.role,
            perms: tenantMembers.permissions,
          })
          .from(tenantMembers)
          .where(eq(tenantMembers.tenantId, t.id));
        const recipients = members
          .filter(
            (m) =>
              m.role === "owner" ||
              (m.perms as string[] | null)?.includes("manage_cash_reconciliation"),
          )
          .map((m) => m.userId);

        await withTenant(t.id, async (tx) => {
          for (const shift of stale) {
            for (const userId of recipients) {
              await createNotification(tx, t.id, shift.branchId, {
                userId,
                kind: "info",
                title: "شيفت خزينة لم يُقفل",
                body: `الشيفت مفتوح منذ ${shift.openedAt.toISOString().slice(0, 10)}`,
                link: `/cash-shifts/${shift.id}`,
              });
            }
            staleNotified += 1;
          }
        });
      }

      if (autoClosed > 0 || staleNotified > 0) {
        logActivity({
          tenantId: t.id,
          actorUserId: null,
          actorName: "نظام (جدولة)",
          action: "cash_shift.sweep",
          category: "settings",
          metadata: { autoClosed, staleNotified },
        });
      }
    } catch (err) {
      failures += 1;
      console.error(
        `[cron/cash-shift-sweep] tenant ${t.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    tenants: tenantRows.length,
    autoClosed,
    staleNotified,
    failures,
  });
}
