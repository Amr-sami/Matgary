// Cash drawer reconciliation. See docs/specs/cash-reconciliation-zreport.md.
//
// A shift is one cashier's session at the drawer: opened with an
// `opening_float`, every cash sale / refund / expense / movement during
// it is linked via `cash_shift_id`, and at close the cashier counts the
// drawer. The variance (counted - expected) is what the owner reviews.
//
// All compute is server-side in numeric SQL; values cross the API as
// strings to preserve precision (same convention as suppliers, POs, etc).

import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  branches,
  cashMovements,
  cashShifts,
  expenses,
  returns,
  sales,
  shopSettings,
  tenantMembers,
  users,
} from "@/lib/db/schema";

export type CashShiftStatus = "open" | "closed" | "reviewed";
export type CashCloseReason = "cashier" | "auto_midnight" | "forced";
export type CashMovementKind = "cash_in" | "cash_out" | "paid_in" | "paid_out";

export interface CashShiftDto {
  id: string;
  branchId: string;
  branchName: string | null;
  cashierUserId: string;
  cashierName: string | null;
  status: CashShiftStatus;
  openedAt: Date;
  openingFloat: string;
  openingNote: string | null;
  closedAt: Date | null;
  closedByUserId: string | null;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
  closingNote: string | null;
  closeReason: CashCloseReason | null;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  totalsSnapshot: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CashMovementDto {
  id: string;
  shiftId: string;
  kind: CashMovementKind;
  amount: string;
  reason: string;
  recordedByUserId: string;
  recordedByName: string | null;
  recordedAt: Date;
}

export interface ShiftCashFlow {
  openingFloat: string;
  cashSales: string;
  cashRefunds: string;
  cashIn: string;
  cashOut: string;
  paidIn: string;
  paidOut: string;
  cashExpenses: string;
  expectedCash: string;
  byMethod: {
    cash: { count: number; total: string };
    card: { count: number; total: string };
    instapay: { count: number; total: string };
    deferred: { count: number; total: string };
  };
  counts: { sales: number; returns: number; expenses: number; movements: number };
  topProducts: { name: string; qty: number; revenue: string }[];
}

export class CashShiftConflictError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CashShiftConflictError";
    this.code = code;
  }
}

/** Thrown by sale/expense write paths when reconciliation is enforced
 *  but the caller has no open shift. The HTTP layer turns this into
 *  409 { code: 'NO_OPEN_SHIFT' } so the client can prompt to open one. */
export class NoOpenShiftError extends Error {
  constructor() {
    super("NO_OPEN_SHIFT");
    this.name = "NoOpenShiftError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ASSIGNEE_DISPLAY_NAME = sql<string | null>`coalesce(${tenantMembers.displayName}, ${users.name})`;

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function resolveDisplayNames(
  tx: Tx,
  tenantId: string,
  userIds: string[],
): Promise<Map<string, string | null>> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ userId: users.id, name: ASSIGNEE_DISPLAY_NAME })
    .from(users)
    .leftJoin(
      tenantMembers,
      and(eq(tenantMembers.userId, users.id), eq(tenantMembers.tenantId, tenantId)),
    )
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.userId, r.name ?? null]));
}

async function resolveBranchNames(
  tx: Tx,
  tenantId: string,
  branchIds: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(branchIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), inArray(branches.id, unique)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function rowToShiftDto(
  row: typeof cashShifts.$inferSelect,
  cashierName: string | null,
  branchName: string | null,
): CashShiftDto {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName,
    cashierUserId: row.cashierUserId,
    cashierName,
    status: row.status as CashShiftStatus,
    openedAt: row.openedAt,
    openingFloat: row.openingFloat,
    openingNote: row.openingNote,
    closedAt: row.closedAt,
    closedByUserId: row.closedByUserId,
    expectedCash: row.expectedCash,
    countedCash: row.countedCash,
    variance: row.variance,
    closingNote: row.closingNote,
    closeReason: (row.closeReason as CashCloseReason | null) ?? null,
    reviewedAt: row.reviewedAt,
    reviewedByUserId: row.reviewedByUserId,
    reviewNote: row.reviewNote,
    totalsSnapshot: row.totalsSnapshot,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function getCurrentShift(
  tenantId: string,
  branchId: string,
  cashierUserId: string,
): Promise<CashShiftDto | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.tenantId, tenantId),
          eq(cashShifts.branchId, branchId),
          eq(cashShifts.cashierUserId, cashierUserId),
          eq(cashShifts.status, "open"),
        ),
      )
      .limit(1);
    if (!row) return null;
    const [names, bnames] = await Promise.all([
      resolveDisplayNames(tx, tenantId, [row.cashierUserId]),
      resolveBranchNames(tx, tenantId, [row.branchId]),
    ]);
    return rowToShiftDto(
      row,
      names.get(row.cashierUserId) ?? null,
      bnames.get(row.branchId) ?? null,
    );
  });
}

export interface ListShiftsFilters {
  cashierUserId?: string;
  branchId?: string;
  status?: CashShiftStatus | "needs_review";
  from?: Date;
  to?: Date;
  /** Force-restrict to a single user — used for staff who only see their own. */
  restrictToCashier?: string;
  limit?: number;
}

export async function listShifts(
  tenantId: string,
  filters: ListShiftsFilters = {},
): Promise<CashShiftDto[]> {
  return withTenant(tenantId, async (tx) => {
    const conditions = [eq(cashShifts.tenantId, tenantId)];
    if (filters.restrictToCashier) {
      conditions.push(eq(cashShifts.cashierUserId, filters.restrictToCashier));
    } else if (filters.cashierUserId) {
      conditions.push(eq(cashShifts.cashierUserId, filters.cashierUserId));
    }
    if (filters.branchId) conditions.push(eq(cashShifts.branchId, filters.branchId));
    if (filters.status === "needs_review") {
      conditions.push(eq(cashShifts.status, "closed"));
      conditions.push(sql`abs(${cashShifts.variance}::numeric) >= 1`);
    } else if (filters.status) {
      conditions.push(eq(cashShifts.status, filters.status));
    }
    if (filters.from) conditions.push(gte(cashShifts.openedAt, filters.from));
    if (filters.to) conditions.push(lte(cashShifts.openedAt, filters.to));

    const rows = await tx
      .select()
      .from(cashShifts)
      .where(and(...conditions))
      .orderBy(desc(cashShifts.openedAt))
      .limit(filters.limit ?? 200);

    const [names, bnames] = await Promise.all([
      resolveDisplayNames(tx, tenantId, rows.map((r) => r.cashierUserId)),
      resolveBranchNames(tx, tenantId, rows.map((r) => r.branchId)),
    ]);
    return rows.map((r) =>
      rowToShiftDto(r, names.get(r.cashierUserId) ?? null, bnames.get(r.branchId) ?? null),
    );
  });
}

export async function getShift(
  tenantId: string,
  id: string,
): Promise<CashShiftDto | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(cashShifts)
      .where(and(eq(cashShifts.tenantId, tenantId), eq(cashShifts.id, id)))
      .limit(1);
    if (!row) return null;
    const [names, bnames] = await Promise.all([
      resolveDisplayNames(tx, tenantId, [row.cashierUserId]),
      resolveBranchNames(tx, tenantId, [row.branchId]),
    ]);
    return rowToShiftDto(
      row,
      names.get(row.cashierUserId) ?? null,
      bnames.get(row.branchId) ?? null,
    );
  });
}

export async function listMovements(
  tenantId: string,
  shiftId: string,
): Promise<CashMovementDto[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(cashMovements)
      .where(
        and(eq(cashMovements.tenantId, tenantId), eq(cashMovements.shiftId, shiftId)),
      )
      .orderBy(desc(cashMovements.recordedAt));
    const names = await resolveDisplayNames(
      tx,
      tenantId,
      rows.map((r) => r.recordedByUserId),
    );
    return rows.map((r) => ({
      id: r.id,
      shiftId: r.shiftId,
      kind: r.kind as CashMovementKind,
      amount: r.amount,
      reason: r.reason,
      recordedByUserId: r.recordedByUserId,
      recordedByName: names.get(r.recordedByUserId) ?? null,
      recordedAt: r.recordedAt,
    }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute (live or for snapshot)
// ─────────────────────────────────────────────────────────────────────────────

/** Compute the cash-flow ladder for a shift. Aggregates everything via SQL
 *  numeric so we never round-trip through JS floats. Used live (for the
 *  drawer panel) and at close (snapshot persisted into totals_snapshot). */
export async function computeShiftCashFlow(
  tenantId: string,
  shiftId: string,
): Promise<ShiftCashFlow> {
  return withTenant(tenantId, async (tx) => {
    const [shift] = await tx
      .select()
      .from(cashShifts)
      .where(and(eq(cashShifts.tenantId, tenantId), eq(cashShifts.id, shiftId)))
      .limit(1);
    if (!shift) throw new CashShiftConflictError("NOT_FOUND", "الشيفت غير موجود");

    // Cash sale totals + counts + per-method breakdown.
    const [byMethod] = await tx
      .select({
        cashTotal: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'cash' and ${sales.cashShiftId} = ${shiftId}), 0)::text`,
        cashCount: sql<number>`coalesce(count(*) filter (where ${sales.paymentMethod} = 'cash' and ${sales.cashShiftId} = ${shiftId}), 0)::int`,
        cardTotal: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'card' and ${sales.cashShiftId} = ${shiftId}), 0)::text`,
        cardCount: sql<number>`coalesce(count(*) filter (where ${sales.paymentMethod} = 'card' and ${sales.cashShiftId} = ${shiftId}), 0)::int`,
        instapayTotal: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'instapay' and ${sales.cashShiftId} = ${shiftId}), 0)::text`,
        instapayCount: sql<number>`coalesce(count(*) filter (where ${sales.paymentMethod} = 'instapay' and ${sales.cashShiftId} = ${shiftId}), 0)::int`,
        deferredTotal: sql<string>`coalesce(sum(${sales.totalPrice}::numeric) filter (where ${sales.paymentMethod} = 'deferred' and ${sales.cashShiftId} = ${shiftId}), 0)::text`,
        deferredCount: sql<number>`coalesce(count(*) filter (where ${sales.paymentMethod} = 'deferred' and ${sales.cashShiftId} = ${shiftId}), 0)::int`,
        totalSaleCount: sql<number>`coalesce(count(*) filter (where ${sales.cashShiftId} = ${shiftId}), 0)::int`,
      })
      .from(sales)
      .where(eq(sales.tenantId, tenantId));

    // Cash refund payouts. We treat a return on a cash sale as cash going OUT.
    // (Refunds on card / instapay don't touch the drawer.)
    const [refundsAgg] = await tx
      .select({
        total: sql<string>`coalesce(sum(${sales.pricePerUnit}::numeric * ${returns.returnedQuantity}), 0)::text`,
        count: sql<number>`coalesce(count(*), 0)::int`,
      })
      .from(returns)
      .innerJoin(sales, eq(sales.id, returns.saleId))
      .where(
        and(
          eq(returns.tenantId, tenantId),
          eq(returns.cashShiftId, shiftId),
          eq(sales.paymentMethod, "cash"),
        ),
      );

    // Cash-paid expenses on this shift.
    const [expensesAgg] = await tx
      .select({
        total: sql<string>`coalesce(sum(${expenses.amount}::numeric), 0)::text`,
        count: sql<number>`coalesce(count(*), 0)::int`,
      })
      .from(expenses)
      .where(
        and(eq(expenses.tenantId, tenantId), eq(expenses.cashShiftId, shiftId)),
      );

    // Movements bucketed by kind.
    const movementRows = await tx
      .select({
        kind: cashMovements.kind,
        total: sql<string>`coalesce(sum(${cashMovements.amount}::numeric), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(cashMovements)
      .where(eq(cashMovements.shiftId, shiftId))
      .groupBy(cashMovements.kind);
    const mByKind: Record<CashMovementKind, { total: string; count: number }> = {
      cash_in: { total: "0", count: 0 },
      cash_out: { total: "0", count: 0 },
      paid_in: { total: "0", count: 0 },
      paid_out: { total: "0", count: 0 },
    };
    let movementCount = 0;
    for (const r of movementRows) {
      mByKind[r.kind as CashMovementKind] = { total: r.total, count: r.count };
      movementCount += r.count;
    }

    // Top 3 products by revenue this shift.
    const topRows = await tx
      .select({
        name: sales.productName,
        qty: sql<number>`coalesce(sum(${sales.quantitySold}), 0)::int`,
        revenue: sql<string>`coalesce(sum(${sales.totalPrice}::numeric), 0)::text`,
      })
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), eq(sales.cashShiftId, shiftId)))
      .groupBy(sales.productName)
      .orderBy(sql`sum(${sales.totalPrice}::numeric) desc`)
      .limit(3);

    const [{ expected }] = await tx
      .select({
        expected: sql<string>`
          (${shift.openingFloat}::numeric
           + ${byMethod.cashTotal}::numeric
           - ${refundsAgg.total}::numeric
           + ${mByKind.cash_in.total}::numeric
           + ${mByKind.paid_in.total}::numeric
           - ${mByKind.cash_out.total}::numeric
           - ${mByKind.paid_out.total}::numeric
           - ${expensesAgg.total}::numeric)::text
        `,
      })
      .from(sql`(values (1)) as _t`);

    return {
      openingFloat: shift.openingFloat,
      cashSales: byMethod.cashTotal,
      cashRefunds: refundsAgg.total,
      cashIn: mByKind.cash_in.total,
      cashOut: mByKind.cash_out.total,
      paidIn: mByKind.paid_in.total,
      paidOut: mByKind.paid_out.total,
      cashExpenses: expensesAgg.total,
      expectedCash: expected,
      byMethod: {
        cash: { count: byMethod.cashCount, total: byMethod.cashTotal },
        card: { count: byMethod.cardCount, total: byMethod.cardTotal },
        instapay: { count: byMethod.instapayCount, total: byMethod.instapayTotal },
        deferred: { count: byMethod.deferredCount, total: byMethod.deferredTotal },
      },
      counts: {
        sales: byMethod.totalSaleCount,
        returns: refundsAgg.count,
        expenses: expensesAgg.count,
        movements: movementCount,
      },
      topProducts: topRows.map((r) => ({
        name: r.name,
        qty: r.qty,
        revenue: r.revenue,
      })),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenShiftInput {
  branchId: string;
  cashierUserId: string;
  openedByUserId: string;
  openingFloat: string;
  openingNote?: string | null;
}

export async function openShift(
  tenantId: string,
  input: OpenShiftInput,
): Promise<CashShiftDto> {
  // Parse / validate the float (numeric, non-negative). String passthrough.
  const openingFloat = Number(input.openingFloat);
  if (!Number.isFinite(openingFloat) || openingFloat < 0) {
    throw new CashShiftConflictError("INVALID_FLOAT", "قيمة الافتتاح غير صحيحة");
  }

  return withTenant(tenantId, async (tx) => {
    // Idempotency: if an open shift exists, return it instead of failing.
    const [existing] = await tx
      .select()
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.tenantId, tenantId),
          eq(cashShifts.branchId, input.branchId),
          eq(cashShifts.cashierUserId, input.cashierUserId),
          eq(cashShifts.status, "open"),
        ),
      )
      .limit(1);
    if (existing) {
      const [names, bnames] = await Promise.all([
        resolveDisplayNames(tx, tenantId, [existing.cashierUserId]),
        resolveBranchNames(tx, tenantId, [existing.branchId]),
      ]);
      return rowToShiftDto(
        existing,
        names.get(existing.cashierUserId) ?? null,
        bnames.get(existing.branchId) ?? null,
      );
    }

    const [created] = await tx
      .insert(cashShifts)
      .values({
        tenantId,
        branchId: input.branchId,
        cashierUserId: input.cashierUserId,
        openedByUserId: input.openedByUserId,
        openingFloat: String(openingFloat),
        openingNote: input.openingNote ?? null,
        status: "open",
      })
      .returning();

    const [names, bnames] = await Promise.all([
      resolveDisplayNames(tx, tenantId, [created.cashierUserId]),
      resolveBranchNames(tx, tenantId, [created.branchId]),
    ]);
    return rowToShiftDto(
      created,
      names.get(created.cashierUserId) ?? null,
      bnames.get(created.branchId) ?? null,
    );
  });
}

export interface RecordMovementInput {
  shiftId: string;
  kind: CashMovementKind;
  amount: string;
  reason: string;
  recordedByUserId: string;
}

export async function recordMovement(
  tenantId: string,
  input: RecordMovementInput,
): Promise<CashMovementDto> {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CashShiftConflictError("INVALID_AMOUNT", "المبلغ غير صحيح");
  }
  if (!input.reason.trim()) {
    throw new CashShiftConflictError("REASON_REQUIRED", "السبب مطلوب");
  }

  return withTenant(tenantId, async (tx) => {
    const [shift] = await tx
      .select()
      .from(cashShifts)
      .where(
        and(eq(cashShifts.tenantId, tenantId), eq(cashShifts.id, input.shiftId)),
      )
      .limit(1);
    if (!shift) throw new CashShiftConflictError("NOT_FOUND", "الشيفت غير موجود");
    if (shift.status !== "open") {
      throw new CashShiftConflictError("NOT_OPEN", "لا يمكن تسجيل حركة على شيفت مقفول");
    }

    const [created] = await tx
      .insert(cashMovements)
      .values({
        tenantId,
        shiftId: input.shiftId,
        kind: input.kind,
        amount: String(amount),
        reason: input.reason.trim(),
        recordedByUserId: input.recordedByUserId,
      })
      .returning();

    const names = await resolveDisplayNames(tx, tenantId, [created.recordedByUserId]);
    return {
      id: created.id,
      shiftId: created.shiftId,
      kind: created.kind as CashMovementKind,
      amount: created.amount,
      reason: created.reason,
      recordedByUserId: created.recordedByUserId,
      recordedByName: names.get(created.recordedByUserId) ?? null,
      recordedAt: created.recordedAt,
    };
  });
}

export interface CloseShiftInput {
  shiftId: string;
  closedByUserId: string;
  countedCash: string;
  closingNote?: string | null;
  closeReason?: CashCloseReason; // default 'cashier'
}

export async function closeShift(
  tenantId: string,
  input: CloseShiftInput,
): Promise<CashShiftDto> {
  const counted = Number(input.countedCash);
  if (!Number.isFinite(counted) || counted < 0) {
    throw new CashShiftConflictError("INVALID_COUNT", "المبلغ المعدود غير صحيح");
  }

  // Compute outside the close transaction so we don't lock for too long.
  // The snapshot we persist is the source of truth from this moment on.
  const flow = await computeShiftCashFlow(tenantId, input.shiftId);

  return withTenant(tenantId, async (tx) => {
    const [shift] = await tx
      .select()
      .from(cashShifts)
      .where(and(eq(cashShifts.tenantId, tenantId), eq(cashShifts.id, input.shiftId)))
      .limit(1);
    if (!shift) throw new CashShiftConflictError("NOT_FOUND", "الشيفت غير موجود");
    // Idempotent close: if already closed, just return the current row.
    if (shift.status !== "open") {
      const [names, bnames] = await Promise.all([
        resolveDisplayNames(tx, tenantId, [shift.cashierUserId]),
        resolveBranchNames(tx, tenantId, [shift.branchId]),
      ]);
      return rowToShiftDto(
        shift,
        names.get(shift.cashierUserId) ?? null,
        bnames.get(shift.branchId) ?? null,
      );
    }

    // Closing-note threshold (per shop_settings).
    const [setting] = await tx
      .select({ thr: shopSettings.cashVarianceNoteThreshold })
      .from(shopSettings)
      .where(
        and(
          eq(shopSettings.tenantId, tenantId),
          eq(shopSettings.branchId, shift.branchId),
        ),
      )
      .limit(1);
    const threshold = Number(setting?.thr ?? 50);
    const variance = counted - Number(flow.expectedCash);
    if (
      Math.abs(variance) >= threshold &&
      !(input.closingNote && input.closingNote.trim())
    ) {
      throw new CashShiftConflictError(
        "NOTE_REQUIRED",
        `الفرق ${Math.abs(variance).toFixed(2)} جنيه يستلزم كتابة ملاحظة`,
      );
    }

    const snapshot = {
      cashFlow: {
        openingFloat: flow.openingFloat,
        cashSales: flow.cashSales,
        cashRefunds: flow.cashRefunds,
        cashIn: flow.cashIn,
        cashOut: flow.cashOut,
        paidIn: flow.paidIn,
        paidOut: flow.paidOut,
        cashExpenses: flow.cashExpenses,
        expectedCash: flow.expectedCash,
      },
      byMethod: flow.byMethod,
      counts: flow.counts,
      topProducts: flow.topProducts,
      computedAt: new Date().toISOString(),
      version: 1,
    } as const;

    const [updated] = await tx
      .update(cashShifts)
      .set({
        status: "closed",
        closedAt: sql`now()`,
        closedByUserId: input.closedByUserId,
        expectedCash: flow.expectedCash,
        countedCash: String(counted),
        closingNote: input.closingNote?.trim() || null,
        closeReason: input.closeReason ?? "cashier",
        totalsSnapshot: snapshot,
        updatedAt: sql`now()`,
      })
      .where(and(eq(cashShifts.tenantId, tenantId), eq(cashShifts.id, input.shiftId)))
      .returning();

    const [names, bnames] = await Promise.all([
      resolveDisplayNames(tx, tenantId, [updated.cashierUserId]),
      resolveBranchNames(tx, tenantId, [updated.branchId]),
    ]);
    return rowToShiftDto(
      updated,
      names.get(updated.cashierUserId) ?? null,
      bnames.get(updated.branchId) ?? null,
    );
  });
}

export async function forceCloseShift(
  tenantId: string,
  shiftId: string,
  closedByUserId: string,
  reason: string,
): Promise<CashShiftDto> {
  if (!reason.trim()) {
    throw new CashShiftConflictError("REASON_REQUIRED", "السبب مطلوب");
  }
  // Compute expected for the record, but counted stays NULL — variance is
  // not meaningful for a force-close because nobody counted the drawer.
  const flow = await computeShiftCashFlow(tenantId, shiftId);

  return withTenant(tenantId, async (tx) => {
    const [shift] = await tx
      .select()
      .from(cashShifts)
      .where(and(eq(cashShifts.tenantId, tenantId), eq(cashShifts.id, shiftId)))
      .limit(1);
    if (!shift) throw new CashShiftConflictError("NOT_FOUND", "الشيفت غير موجود");
    if (shift.status !== "open") {
      throw new CashShiftConflictError("NOT_OPEN", "الشيفت مقفول بالفعل");
    }

    const snapshot = {
      cashFlow: {
        openingFloat: flow.openingFloat,
        cashSales: flow.cashSales,
        cashRefunds: flow.cashRefunds,
        cashIn: flow.cashIn,
        cashOut: flow.cashOut,
        paidIn: flow.paidIn,
        paidOut: flow.paidOut,
        cashExpenses: flow.cashExpenses,
        expectedCash: flow.expectedCash,
      },
      byMethod: flow.byMethod,
      counts: flow.counts,
      topProducts: flow.topProducts,
      computedAt: new Date().toISOString(),
      version: 1,
    } as const;

    const [updated] = await tx
      .update(cashShifts)
      .set({
        status: "closed",
        closedAt: sql`now()`,
        closedByUserId,
        expectedCash: flow.expectedCash,
        countedCash: null,
        closingNote: reason.trim(),
        closeReason: "forced",
        totalsSnapshot: snapshot,
        updatedAt: sql`now()`,
      })
      .where(and(eq(cashShifts.tenantId, tenantId), eq(cashShifts.id, shiftId)))
      .returning();

    const [names, bnames] = await Promise.all([
      resolveDisplayNames(tx, tenantId, [updated.cashierUserId]),
      resolveBranchNames(tx, tenantId, [updated.branchId]),
    ]);
    return rowToShiftDto(
      updated,
      names.get(updated.cashierUserId) ?? null,
      bnames.get(updated.branchId) ?? null,
    );
  });
}

export async function reviewShift(
  tenantId: string,
  shiftId: string,
  reviewedByUserId: string,
  reviewNote: string | null,
): Promise<CashShiftDto> {
  return withTenant(tenantId, async (tx) => {
    const [shift] = await tx
      .select()
      .from(cashShifts)
      .where(and(eq(cashShifts.tenantId, tenantId), eq(cashShifts.id, shiftId)))
      .limit(1);
    if (!shift) throw new CashShiftConflictError("NOT_FOUND", "الشيفت غير موجود");
    if (shift.status !== "closed") {
      throw new CashShiftConflictError(
        "NOT_CLOSED",
        "لا يمكن مراجعة شيفت غير مقفول",
      );
    }

    const [updated] = await tx
      .update(cashShifts)
      .set({
        status: "reviewed",
        reviewedAt: sql`now()`,
        reviewedByUserId,
        reviewNote: reviewNote?.trim() || null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(cashShifts.tenantId, tenantId), eq(cashShifts.id, shiftId)))
      .returning();

    const [names, bnames] = await Promise.all([
      resolveDisplayNames(tx, tenantId, [updated.cashierUserId]),
      resolveBranchNames(tx, tenantId, [updated.branchId]),
    ]);
    return rowToShiftDto(
      updated,
      names.get(updated.cashierUserId) ?? null,
      bnames.get(updated.branchId) ?? null,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stamp helper — called from sale/expense write paths
// ─────────────────────────────────────────────────────────────────────────────

/** Look up the open shift the caller can stamp this cash row onto.
 *  - paymentMethod !== 'cash' → returns null (non-cash never touches drawer).
 *  - Cashier has an open shift → returns shift.id.
 *  - Owner has no open shift AND `autoOpenOwnerDesk` → auto-opens one.
 *  - Cashier (non-owner) has no shift → throws `NoOpenShiftError` so the
 *    HTTP layer can return 409 NO_OPEN_SHIFT.
 *
 *  Enforcement is gated by `shop_settings.cash_reconciliation_enabled`.
 *  When disabled, this function is a no-op (returns null) so existing
 *  flows are unchanged.
 */
export async function resolveShiftStampForSale(
  tx: Tx,
  args: {
    tenantId: string;
    branchId: string;
    recordedByUserId: string | null;
    isOwner: boolean;
    paymentMethod: string;
  },
): Promise<string | null> {
  if (args.paymentMethod !== "cash") return null;
  if (!args.recordedByUserId) return null;

  const [setting] = await tx
    .select({ enabled: shopSettings.cashReconciliationEnabled })
    .from(shopSettings)
    .where(
      and(
        eq(shopSettings.tenantId, args.tenantId),
        eq(shopSettings.branchId, args.branchId),
      ),
    )
    .limit(1);
  if (!setting?.enabled) return null;

  const [existing] = await tx
    .select({ id: cashShifts.id })
    .from(cashShifts)
    .where(
      and(
        eq(cashShifts.tenantId, args.tenantId),
        eq(cashShifts.branchId, args.branchId),
        eq(cashShifts.cashierUserId, args.recordedByUserId),
        eq(cashShifts.status, "open"),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  // Owner-desk auto-shift: owners get a zero-float shift implicitly so
  // the daily cron can close it and we don't block their walk-in sales.
  if (args.isOwner) {
    const [created] = await tx
      .insert(cashShifts)
      .values({
        tenantId: args.tenantId,
        branchId: args.branchId,
        cashierUserId: args.recordedByUserId,
        openedByUserId: args.recordedByUserId,
        openingFloat: "0",
        openingNote: "owner desk (auto)",
        status: "open",
      })
      .returning({ id: cashShifts.id });
    return created.id;
  }

  throw new NoOpenShiftError();
}

// Internal: list shifts whose business day has rolled past and the only
// activity is an owner-desk auto-open. Caller (cron) auto-closes these.
export async function listAutoCloseCandidates(
  tenantId: string,
  cutoff: Date,
): Promise<{ id: string; branchId: string; cashierUserId: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: cashShifts.id,
        branchId: cashShifts.branchId,
        cashierUserId: cashShifts.cashierUserId,
      })
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.tenantId, tenantId),
          eq(cashShifts.status, "open"),
          eq(cashShifts.openingNote, "owner desk (auto)"),
          lte(cashShifts.openedAt, cutoff),
        ),
      );
    return rows;
  });
}

// Internal: list shifts open > N hours, for the "shift_left_open" notification.
export async function listStaleOpenShifts(
  tenantId: string,
  cutoff: Date,
): Promise<{ id: string; branchId: string; cashierUserId: string; openedAt: Date }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: cashShifts.id,
        branchId: cashShifts.branchId,
        cashierUserId: cashShifts.cashierUserId,
        openedAt: cashShifts.openedAt,
      })
      .from(cashShifts)
      .where(
        and(
          eq(cashShifts.tenantId, tenantId),
          eq(cashShifts.status, "open"),
          // exclude owner-desk auto-shifts; they have their own sweep
          or(
            isNull(cashShifts.openingNote),
            sql`${cashShifts.openingNote} <> 'owner desk (auto)'`,
          )!,
          lte(cashShifts.openedAt, cutoff),
        ),
      );
    return rows;
  });
}
