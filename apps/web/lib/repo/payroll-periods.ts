// Payroll V1 — persistence + lifecycle.
//
// The engine (lib/payroll/engine.ts) produces a live snapshot from the raw
// inputs; THIS module is the only code path that writes `payroll_periods` /
// `payroll_adjustments` rows. Keeping the persistence API small keeps the
// state machine honest:
//
//   MISSING   – no row for (tenant, employee, month). Default after membership.
//   DRAFT     – at least one calculate has run. Mutable; recalculating in-
//               place overwrites the body.
//   FINALIZED – snapshot + compensation_snapshot frozen; DB trigger refuses
//               any UPDATE except the void transition.
//   VOIDED    – one-way from FINALIZED. The row stays (audit / PDF
//               reproducibility) but is excluded from the P&L and from the
//               `payroll_periods_tenant_employee_period_live_idx` partial
//               unique, so a new DRAFT for the same month can be opened.
//
// The public surface:
//   • `listPayrollMonth(tenantId, periodStart)` – register page data
//   • `getEmployeePayrollMonth(...)`            – single sheet (web + mobile)
//   • `upsertPayrollDraft(...)`                 – recompute → write DRAFT
//   • `finalizePayrollPeriod(...)`              – DRAFT → FINALIZED
//   • `voidPayrollPeriod(...)`                  – FINALIZED → VOIDED
//   • `createPayrollAdjustment(...)` / `voidPayrollAdjustment(...)`
//   • `listPayrollAdjustments(...)`
//
// All mutations go through `withTenant`, so RLS applies. Both calculate and
// finalize read the full set of inputs through the engine — there's exactly
// one source of truth for the snapshot shape.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import {
  payrollAdjustments,
  payrollPeriods,
  tenantMembers,
  users,
  type PayrollAdjustmentRow,
  type PayrollPeriodRow,
} from "@/lib/db/schema";
import {
  computePayrollForEmployee,
  normalizeMonth,
  type AdjustmentSnapshot,
  type CompensationSnapshot,
  type PayrollSnapshot,
} from "@/lib/payroll/engine";

/* ─────────────────────────── Public types ────────────────────────────── */

export type PayrollLifecycle = "MISSING" | "DRAFT" | "FINALIZED" | "VOIDED";

export interface PayrollSheetView {
  employeeId: string;
  employeeName: string | null;
  role: string;
  lifecycle: PayrollLifecycle;
  /** Null when lifecycle = MISSING. */
  periodId: string | null;
  periodStart: string;
  periodEnd: string;
  /** For MISSING/DRAFT this is the live snapshot computed just now.
   *  For FINALIZED/VOIDED this is the stored snapshot (frozen). */
  snapshot: PayrollSnapshot;
  compensationSnapshot: CompensationSnapshot | null;
  finalizedAt: string | null;
  finalizedByUserId: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
}

export interface PayrollRegisterRow extends PayrollSheetView {}

/* ─────────────────────── Helpers / row→view ──────────────────────────── */

/** Translate stored JSONB back into the snapshot shape. `snapshot` is a
 *  broad JSONB blob — we trust the writer (this module) to have produced
 *  a `PayrollSnapshot` and cast the pointer back. */
function parseStoredSnapshot(raw: unknown): PayrollSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as PayrollSnapshot;
}

function parseStoredCompensation(raw: unknown): CompensationSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as CompensationSnapshot;
}

function rowLifecycle(row: PayrollPeriodRow | null): PayrollLifecycle {
  if (!row) return "MISSING";
  if (row.status === "voided") return "VOIDED";
  if (row.status === "finalized") return "FINALIZED";
  return "DRAFT";
}

function rowToView(args: {
  row: PayrollPeriodRow | null;
  liveSnapshot: PayrollSnapshot;
  liveComp: CompensationSnapshot | null;
  employeeId: string;
  employeeName: string | null;
  role: string;
  periodStart: Date;
  periodEnd: Date;
}): PayrollSheetView {
  const { row, liveSnapshot, liveComp } = args;
  const lifecycle = rowLifecycle(row);

  // DRAFT/MISSING → surface the live snapshot (recomputed on every read).
  // FINALIZED/VOIDED → the stored snapshot wins; later rate / attendance /
  // sales changes cannot mutate a frozen sheet.
  const useStored = lifecycle === "FINALIZED" || lifecycle === "VOIDED";
  const snapshot = useStored
    ? (parseStoredSnapshot(row!.snapshot) ?? liveSnapshot)
    : liveSnapshot;
  const compensationSnapshot = useStored
    ? parseStoredCompensation(row!.compensationSnapshot)
    : liveComp;

  return {
    employeeId: args.employeeId,
    employeeName: args.employeeName,
    role: args.role,
    lifecycle,
    periodId: row?.id ?? null,
    periodStart: args.periodStart.toISOString(),
    periodEnd: args.periodEnd.toISOString(),
    snapshot,
    compensationSnapshot,
    finalizedAt: row?.finalizedAt?.toISOString() ?? null,
    finalizedByUserId: row?.finalizedByUserId ?? null,
    voidedAt: row?.voidedAt?.toISOString() ?? null,
    voidedByUserId: row?.voidedByUserId ?? null,
    voidReason: row?.voidReason ?? null,
  };
}

/* ─────────────────────────── Reads ───────────────────────────────────── */

/**
 * Register for one month across every tenant member. The row for an employee
 * with no persistence-layer record comes back with lifecycle = MISSING and a
 * live snapshot computed on the fly.
 */
export async function listPayrollMonth(
  tenantId: string,
  periodStart: Date,
): Promise<PayrollRegisterRow[]> {
  const { periodStart: ps, periodEnd: pe } = normalizeMonth(periodStart);

  return withTenant(tenantId, async (tx) => {
    // Every tenant member. Membership is the gate for "gets a sheet".
    const memberRows = await tx
      .select({
        userId: tenantMembers.userId,
        displayName: tenantMembers.displayName,
        role: tenantMembers.role,
        userName: users.name,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(eq(tenantMembers.tenantId, tenantId))
      .orderBy(sql`coalesce(${tenantMembers.displayName}, ${users.name}) asc`);

    if (memberRows.length === 0) return [];

    const memberIds = memberRows.map((m) => m.userId);

    // Live non-voided rows for this period. Partial unique guarantees ≤1 per
    // (tenant, employee, month); listing by `status <> voided` does the rest.
    const liveRows = await tx
      .select()
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.tenantId, tenantId),
          eq(payrollPeriods.periodStart, ps),
          inArray(payrollPeriods.employeeId, memberIds),
          sql`${payrollPeriods.status} <> 'voided'`,
        ),
      );
    const byEmployee = new Map(liveRows.map((r) => [r.employeeId, r]));

    // Compute live snapshots sequentially (small N; per-employee read).
    const out: PayrollRegisterRow[] = [];
    for (const m of memberRows) {
      const row = byEmployee.get(m.userId) ?? null;
      const live = await computePayrollForEmployee(tenantId, m.userId, ps, pe);
      out.push(
        rowToView({
          row,
          liveSnapshot: live.snapshot,
          liveComp: live.compensationSnapshot,
          employeeId: m.userId,
          employeeName: m.displayName ?? m.userName,
          role: m.role,
          periodStart: ps,
          periodEnd: pe,
        }),
      );
    }
    return out;
  });
}

export async function getEmployeePayrollMonth(
  tenantId: string,
  employeeId: string,
  periodStart: Date,
): Promise<PayrollSheetView | null> {
  const { periodStart: ps, periodEnd: pe } = normalizeMonth(periodStart);

  return withTenant(tenantId, async (tx) => {
    const memberRows = await tx
      .select({
        displayName: tenantMembers.displayName,
        role: tenantMembers.role,
        userName: users.name,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, employeeId)),
      )
      .limit(1);
    const member = memberRows[0];
    if (!member) return null;

    const [row] = await tx
      .select()
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.tenantId, tenantId),
          eq(payrollPeriods.employeeId, employeeId),
          eq(payrollPeriods.periodStart, ps),
          sql`${payrollPeriods.status} <> 'voided'`,
        ),
      )
      .limit(1);

    const live = await computePayrollForEmployee(tenantId, employeeId, ps, pe);

    return rowToView({
      row: row ?? null,
      liveSnapshot: live.snapshot,
      liveComp: live.compensationSnapshot,
      employeeId,
      employeeName: member.displayName ?? member.userName,
      role: member.role,
      periodStart: ps,
      periodEnd: pe,
    });
  });
}

/* ─────────────────────── Lifecycle mutations ─────────────────────────── */

export class PayrollLifecycleError extends Error {
  constructor(public code: "ALREADY_FINALIZED" | "NOT_FOUND" | "NOT_FINALIZED" | "VOIDED", message: string) {
    super(message);
    this.name = "PayrollLifecycleError";
  }
}

/**
 * Recompute + upsert the DRAFT row for (tenant, employee, month). Idempotent:
 * calling twice with no underlying changes writes the same snapshot. Fails
 * if the live row is already FINALIZED (void it first for a redo).
 */
export async function upsertPayrollDraft(
  tenantId: string,
  employeeId: string,
  periodStart: Date,
): Promise<PayrollSheetView> {
  const { periodStart: ps, periodEnd: pe } = normalizeMonth(periodStart);
  const live = await computePayrollForEmployee(tenantId, employeeId, ps, pe);

  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.tenantId, tenantId),
          eq(payrollPeriods.employeeId, employeeId),
          eq(payrollPeriods.periodStart, ps),
          sql`${payrollPeriods.status} <> 'voided'`,
        ),
      )
      .limit(1);

    if (existing && existing.status === "finalized") {
      throw new PayrollLifecycleError(
        "ALREADY_FINALIZED",
        "This period is finalized. Void it before recalculating.",
      );
    }

    const snap = live.snapshot;
    const comp = live.compensationSnapshot;
    const values = {
      tenantId,
      employeeId,
      periodStart: ps,
      periodEnd: pe,
      regularHours: String(snap.regularHours),
      overtimeHours: String(snap.overtimeHours),
      grossAmount: String(snap.grossAmount),
      commissionAmount: String(snap.commissionAmount),
      adjustmentsTotal: String(snap.adjustmentsTotal),
      // Legacy column — mirror adjustmentsTotal so pre-V1 readers (P&L fallback)
      // keep working even if they haven't been updated to look at snapshot JSON.
      adjustmentsAmount: String(snap.adjustmentsTotal),
      netAmount: String(snap.netAmount),
      snapshot: snap,
      compensationSnapshot: comp,
      calculationVersion: snap.calculationVersion,
      status: "draft" as const,
    };

    let savedRow: PayrollPeriodRow;
    if (existing) {
      const [row] = await tx
        .update(payrollPeriods)
        .set(values)
        .where(eq(payrollPeriods.id, existing.id))
        .returning();
      savedRow = row;
    } else {
      const [row] = await tx.insert(payrollPeriods).values(values).returning();
      savedRow = row;
    }

    // Re-use the view assembler so the shape here matches `getEmployeePayroll...`.
    const memberRows = await tx
      .select({
        displayName: tenantMembers.displayName,
        role: tenantMembers.role,
        userName: users.name,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, employeeId)),
      )
      .limit(1);
    const member = memberRows[0];

    return rowToView({
      row: savedRow,
      liveSnapshot: snap,
      liveComp: comp,
      employeeId,
      employeeName: member?.displayName ?? member?.userName ?? null,
      role: member?.role ?? "staff",
      periodStart: ps,
      periodEnd: pe,
    });
  });
}

/**
 * DRAFT → FINALIZED. If no DRAFT exists, computes a fresh one and finalizes
 * it in a single transaction (the UI "Finalize" button should normally run
 * `upsertPayrollDraft` first, but the one-shot path makes the AI preview
 * simpler and test cases cleaner).
 */
export async function finalizePayrollPeriod(
  tenantId: string,
  employeeId: string,
  periodStart: Date,
  finalizedByUserId: string,
): Promise<PayrollSheetView> {
  const { periodStart: ps, periodEnd: pe } = normalizeMonth(periodStart);
  const live = await computePayrollForEmployee(tenantId, employeeId, ps, pe);

  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.tenantId, tenantId),
          eq(payrollPeriods.employeeId, employeeId),
          eq(payrollPeriods.periodStart, ps),
          sql`${payrollPeriods.status} <> 'voided'`,
        ),
      )
      .limit(1);
    if (existing?.status === "finalized") {
      throw new PayrollLifecycleError(
        "ALREADY_FINALIZED",
        "Period is already finalized. Void it to make changes.",
      );
    }

    const snap = live.snapshot;
    const comp = live.compensationSnapshot;
    const now = new Date();
    const values = {
      tenantId,
      employeeId,
      periodStart: ps,
      periodEnd: pe,
      regularHours: String(snap.regularHours),
      overtimeHours: String(snap.overtimeHours),
      grossAmount: String(snap.grossAmount),
      commissionAmount: String(snap.commissionAmount),
      adjustmentsTotal: String(snap.adjustmentsTotal),
      adjustmentsAmount: String(snap.adjustmentsTotal),
      netAmount: String(snap.netAmount),
      snapshot: snap,
      compensationSnapshot: comp,
      calculationVersion: snap.calculationVersion,
      status: "finalized" as const,
      finalizedAt: now,
      finalizedByUserId,
    };

    let savedRow: PayrollPeriodRow;
    if (existing) {
      const [row] = await tx
        .update(payrollPeriods)
        .set(values)
        .where(eq(payrollPeriods.id, existing.id))
        .returning();
      savedRow = row;
    } else {
      const [row] = await tx.insert(payrollPeriods).values(values).returning();
      savedRow = row;
    }

    const memberRows = await tx
      .select({
        displayName: tenantMembers.displayName,
        role: tenantMembers.role,
        userName: users.name,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, employeeId)),
      )
      .limit(1);
    const member = memberRows[0];

    return rowToView({
      row: savedRow,
      liveSnapshot: snap,
      liveComp: comp,
      employeeId,
      employeeName: member?.displayName ?? member?.userName ?? null,
      role: member?.role ?? "staff",
      periodStart: ps,
      periodEnd: pe,
    });
  });
}

/**
 * FINALIZED → VOIDED. The DB trigger rejects any UPDATE on a finalized row
 * except this transition; we therefore update exactly the void columns.
 */
export async function voidPayrollPeriod(
  tenantId: string,
  periodId: string,
  voidedByUserId: string,
  reason: string | null,
): Promise<PayrollPeriodRow> {
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(payrollPeriods)
      .where(and(eq(payrollPeriods.tenantId, tenantId), eq(payrollPeriods.id, periodId)))
      .limit(1);
    if (!existing) {
      throw new PayrollLifecycleError("NOT_FOUND", "Period not found.");
    }
    if (existing.status === "voided") {
      throw new PayrollLifecycleError("VOIDED", "Period is already voided.");
    }
    if (existing.status !== "finalized") {
      throw new PayrollLifecycleError(
        "NOT_FINALIZED",
        "Only finalized periods can be voided. Delete the draft instead.",
      );
    }
    const [row] = await tx
      .update(payrollPeriods)
      .set({
        status: "voided",
        voidedAt: new Date(),
        voidedByUserId,
        voidReason: reason,
      })
      .where(eq(payrollPeriods.id, periodId))
      .returning();
    return row;
  });
}

/* ─────────────────────── Adjustments CRUD ────────────────────────────── */

export interface CreateAdjustmentInput {
  employeeId: string;
  periodStart: Date;
  kind: AdjustmentSnapshot["kind"];
  amount: number;
  reason: string | null;
  createdByUserId: string;
}

export async function createPayrollAdjustment(
  tenantId: string,
  input: CreateAdjustmentInput,
): Promise<PayrollAdjustmentRow> {
  const { periodStart } = normalizeMonth(input.periodStart);
  return withTenant(tenantId, async (tx) => {
    // If the period is already finalized the live-row probe will find it;
    // we refuse to add live adjustments into a finalized month — the Owner
    // must void + redraft to revise the sheet.
    const [existingPeriod] = await tx
      .select({ status: payrollPeriods.status })
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.tenantId, tenantId),
          eq(payrollPeriods.employeeId, input.employeeId),
          eq(payrollPeriods.periodStart, periodStart),
          sql`${payrollPeriods.status} <> 'voided'`,
        ),
      )
      .limit(1);
    if (existingPeriod?.status === "finalized") {
      throw new PayrollLifecycleError(
        "ALREADY_FINALIZED",
        "Cannot add adjustments to a finalized period. Void and redraft first.",
      );
    }

    const [row] = await tx
      .insert(payrollAdjustments)
      .values({
        tenantId,
        employeeId: input.employeeId,
        periodMonth: periodStart,
        kind: input.kind,
        amount: String(input.amount),
        reason: input.reason,
        createdByUserId: input.createdByUserId,
      })
      .returning();
    return row;
  });
}

export async function voidPayrollAdjustment(
  tenantId: string,
  id: string,
  voidedByUserId: string,
): Promise<PayrollAdjustmentRow> {
  return withTenant(tenantId, async (tx) => {
    // Refuse if the containing period is already finalized — a bonus that's
    // frozen into a signed sheet cannot be retroactively retracted.
    const [existing] = await tx
      .select()
      .from(payrollAdjustments)
      .where(and(eq(payrollAdjustments.tenantId, tenantId), eq(payrollAdjustments.id, id)))
      .limit(1);
    if (!existing) {
      throw new PayrollLifecycleError("NOT_FOUND", "Adjustment not found.");
    }
    if (existing.voidedAt) return existing; // idempotent

    const [parent] = await tx
      .select({ status: payrollPeriods.status })
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.tenantId, tenantId),
          eq(payrollPeriods.employeeId, existing.employeeId),
          eq(payrollPeriods.periodStart, existing.periodMonth),
          sql`${payrollPeriods.status} <> 'voided'`,
        ),
      )
      .limit(1);
    if (parent?.status === "finalized") {
      throw new PayrollLifecycleError(
        "ALREADY_FINALIZED",
        "Containing period is finalized. Void the period first.",
      );
    }

    const [row] = await tx
      .update(payrollAdjustments)
      .set({ voidedAt: new Date(), voidedByUserId })
      .where(eq(payrollAdjustments.id, id))
      .returning();
    return row;
  });
}

export async function listPayrollAdjustments(
  tenantId: string,
  employeeId: string,
  periodStart: Date,
): Promise<PayrollAdjustmentRow[]> {
  const { periodStart: ps } = normalizeMonth(periodStart);
  return withTenant(tenantId, async (tx) => {
    return tx
      .select()
      .from(payrollAdjustments)
      .where(
        and(
          eq(payrollAdjustments.tenantId, tenantId),
          eq(payrollAdjustments.employeeId, employeeId),
          eq(payrollAdjustments.periodMonth, ps),
          isNull(payrollAdjustments.voidedAt),
        ),
      )
      .orderBy(sql`${payrollAdjustments.createdAt} asc`);
  });
}

/* ─────────────────────── Finalized-period helper ─────────────────────── */

/**
 * Does ANY live (draft or finalized, not voided) payroll row exist for
 * (tenant, month)? The Financials double-count guard calls this before
 * accepting a manual "Salaries" expense — a staged payroll already captures
 * the month's labor cost.
 */
export async function hasFinalizedPayrollForMonth(
  tenantId: string,
  periodStart: Date,
): Promise<boolean> {
  const { periodStart: ps } = normalizeMonth(periodStart);
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: payrollPeriods.id })
      .from(payrollPeriods)
      .where(
        and(
          eq(payrollPeriods.tenantId, tenantId),
          eq(payrollPeriods.periodStart, ps),
          eq(payrollPeriods.status, "finalized"),
        ),
      )
      .limit(1);
    return !!row;
  });
}
