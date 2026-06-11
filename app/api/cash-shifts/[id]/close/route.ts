import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createNotification } from "@/lib/repo/notifications";
import { requireTenant } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import { db, withTenant } from "@/lib/db";
import { tenantMembers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  CashShiftConflictError,
  closeShift,
  getShift,
} from "@/lib/repo/cash-shifts";
import { logActivity } from "@/lib/repo/activity";

const closeSchema = z.object({
  countedCash: z.union([z.number(), z.string()]),
  closingNote: z.string().max(1000).nullable().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { id } = await params;

  const existing = await getShift(r.ctx.tenantId, id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const isManager = can(r.ctx, "manage_cash_reconciliation");
  if (!isManager && existing.cashierUserId !== r.ctx.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  try {
    const shift = await closeShift(r.ctx.tenantId, {
      shiftId: id,
      closedByUserId: r.ctx.userId,
      countedCash: String(parsed.data.countedCash),
      closingNote: parsed.data.closingNote ?? null,
    });
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "cash_shift.close",
      category: "settings",
      entityType: "cash_shift",
      entityId: id,
      branchId: shift.branchId,
      metadata: {
        expected: shift.expectedCash,
        counted: shift.countedCash,
        variance: shift.variance,
      },
    });

    // Variance ≥ ₤1 → ping every manager with manage_cash_reconciliation
    // so the review queue surfaces immediately. Fire-and-forget: the close
    // itself succeeds even if notifications fail.
    const variance = Number(shift.variance ?? 0);
    if (Math.abs(variance) >= 1) {
      try {
        const members = await db
          .select({ userId: tenantMembers.userId, role: tenantMembers.role, perms: tenantMembers.permissions })
          .from(tenantMembers)
          .where(eq(tenantMembers.tenantId, r.ctx.tenantId));
        const recipients = members
          .filter(
            (m) =>
              m.role === "owner" ||
              (m.perms as string[] | null)?.includes("manage_cash_reconciliation"),
          )
          .map((m) => m.userId);
        const direction = variance < 0 ? "عجز" : "زيادة";
        const abs = Math.abs(variance).toFixed(2);
        await withTenant(r.ctx.tenantId, async (tx) => {
          for (const userId of recipients) {
            await createNotification(tx, r.ctx.tenantId, shift.branchId, {
              userId,
              kind: "info",
              title: `${direction} ${abs} في خزينة ${shift.cashierName ?? ""}`.trim(),
              body: `الفرع: ${shift.branchName ?? ""}`,
              link: `/cash-shifts/${shift.id}`,
            });
          }
        });
      } catch {
        // best-effort
      }
    }

    return NextResponse.json({ shift });
  } catch (err) {
    if (err instanceof CashShiftConflictError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 409 },
      );
    }
    throw err;
  }
}
