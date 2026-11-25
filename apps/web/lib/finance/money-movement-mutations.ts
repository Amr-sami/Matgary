// Final slice — Money Movements CRUD.
//
// Money movements are non-P&L cash movements. They are tracked for operator
// visibility but the P&L engine explicitly excludes them from revenue,
// expenses, COGS, and profit. See `moneyMovementDirection` in
// lib/finance/pnl.ts for the direction classifier.

import "server-only";

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { moneyMovements } from "@/lib/db/schema";

/** Union of allowed `kind` values. The CHECK constraint on the column
 *  enforces this at the DB layer too; the application-side literal keeps
 *  TypeScript honest about which strings we accept. */
export const MONEY_MOVEMENT_KINDS = [
  "owner_deposit",
  "owner_withdrawal",
  "cash_transfer",
  "loan_received",
  "loan_principal_repayment",
  "supplier_payment_direct",
  "customer_deposit",
  "other",
] as const;
export type MoneyMovementKind = (typeof MONEY_MOVEMENT_KINDS)[number];

export function isMoneyMovementKind(v: unknown): v is MoneyMovementKind {
  return (
    typeof v === "string" &&
    (MONEY_MOVEMENT_KINDS as readonly string[]).includes(v)
  );
}

export interface MoneyMovementRow {
  id: string;
  kind: MoneyMovementKind;
  direction: "in" | "out";
  amount: number;
  occurredAt: string;
  description: string | null;
  paymentMethod: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdByUserId: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
}

/** Same classifier the engine uses — surfaced here so the API shapes
 *  responses consistently without importing from the pure engine module. */
const MONEY_OUT_KINDS = new Set<MoneyMovementKind>([
  "owner_withdrawal",
  "cash_transfer",
  "loan_principal_repayment",
  "supplier_payment_direct",
]);

export function directionFor(kind: MoneyMovementKind): "in" | "out" {
  return MONEY_OUT_KINDS.has(kind) ? "out" : "in";
}

export interface ListMoneyMovementsFilters {
  from?: Date;
  to?: Date;
  kind?: MoneyMovementKind;
  status?: "active" | "voided" | "any";
  limit?: number;
  cursor?: string | null;
}

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

export async function listMoneyMovements(
  tenantId: string,
  filters: ListMoneyMovementsFilters = {},
): Promise<{ data: MoneyMovementRow[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(filters.limit ?? PAGE_DEFAULT, PAGE_MAX));
  const status = filters.status ?? "active";

  return withTenant(tenantId, async (tx) => {
    const where = [eq(moneyMovements.tenantId, tenantId)];
    if (filters.from) where.push(gte(moneyMovements.occurredAt, filters.from));
    if (filters.to) where.push(lte(moneyMovements.occurredAt, filters.to));
    if (filters.kind) where.push(eq(moneyMovements.kind, filters.kind));
    if (status === "active")
      where.push(sql`${moneyMovements.voidedAt} is null`);
    else if (status === "voided")
      where.push(sql`${moneyMovements.voidedAt} is not null`);

    if (filters.cursor) {
      const idx = filters.cursor.lastIndexOf(":");
      if (idx > 0) {
        const dateStr = filters.cursor.slice(0, idx);
        const cursorId = filters.cursor.slice(idx + 1);
        const cursorDate = new Date(dateStr);
        if (!Number.isNaN(cursorDate.getTime())) {
          where.push(
            sql`(${moneyMovements.occurredAt}, ${moneyMovements.id}) < (${cursorDate.toISOString()}::timestamptz, ${cursorId}::uuid)`,
          );
        }
      }
    }

    const rows = await tx
      .select({
        id: moneyMovements.id,
        kind: moneyMovements.kind,
        amount: moneyMovements.amount,
        occurredAt: moneyMovements.occurredAt,
        description: moneyMovements.description,
        paymentMethod: moneyMovements.paymentMethod,
        relatedEntityType: moneyMovements.relatedEntityType,
        relatedEntityId: moneyMovements.relatedEntityId,
        createdByUserId: moneyMovements.createdByUserId,
        voidedAt: moneyMovements.voidedAt,
        voidedByUserId: moneyMovements.voidedByUserId,
        voidReason: moneyMovements.voidReason,
      })
      .from(moneyMovements)
      .where(and(...where))
      .orderBy(desc(moneyMovements.occurredAt), desc(moneyMovements.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? `${page[page.length - 1].occurredAt.toISOString()}:${page[page.length - 1].id}`
      : null;

    return {
      data: page.map((r) => {
        const kind = r.kind as MoneyMovementKind;
        return {
          id: r.id,
          kind,
          direction: directionFor(kind),
          amount: Number(r.amount),
          occurredAt: r.occurredAt.toISOString(),
          description: r.description,
          paymentMethod: r.paymentMethod,
          relatedEntityType: r.relatedEntityType,
          relatedEntityId: r.relatedEntityId,
          createdByUserId: r.createdByUserId,
          voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
          voidedByUserId: r.voidedByUserId,
          voidReason: r.voidReason,
        };
      }),
      nextCursor,
    };
  });
}

export interface CreateMoneyMovementInput {
  kind: MoneyMovementKind;
  amount: number;
  occurredAt?: Date;
  description?: string | null;
  paymentMethod?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  createdByUserId: string;
}

export async function createMoneyMovement(
  tenantId: string,
  input: CreateMoneyMovementInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(moneyMovements)
      .values({
        tenantId,
        kind: input.kind,
        amount: String(input.amount),
        occurredAt: input.occurredAt ?? new Date(),
        description: input.description ?? null,
        paymentMethod: input.paymentMethod ?? null,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        createdByUserId: input.createdByUserId,
      })
      .returning({ id: moneyMovements.id });
    return { id: row.id };
  });
}

/** Non-financial edits only — amount, kind, and occurredAt stay fixed once
 *  recorded (an incorrect value is handled by voiding + re-creating).
 *  Description / paymentMethod / related entity metadata can be cleaned up. */
export async function updateMoneyMovement(
  tenantId: string,
  id: string,
  patch: {
    description?: string | null;
    paymentMethod?: string | null;
    relatedEntityType?: string | null;
    relatedEntityId?: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: "NOT_FOUND" | "VOIDED" }> {
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ voidedAt: moneyMovements.voidedAt })
      .from(moneyMovements)
      .where(and(eq(moneyMovements.tenantId, tenantId), eq(moneyMovements.id, id)))
      .limit(1);
    if (!existing) return { ok: false, reason: "NOT_FOUND" } as const;
    if (existing.voidedAt) return { ok: false, reason: "VOIDED" } as const;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.paymentMethod !== undefined) updates.paymentMethod = patch.paymentMethod;
    if (patch.relatedEntityType !== undefined) updates.relatedEntityType = patch.relatedEntityType;
    if (patch.relatedEntityId !== undefined) updates.relatedEntityId = patch.relatedEntityId;
    if (Object.keys(updates).length === 1) return { ok: true } as const;

    await tx
      .update(moneyMovements)
      .set(updates)
      .where(and(eq(moneyMovements.tenantId, tenantId), eq(moneyMovements.id, id)));
    return { ok: true } as const;
  });
}

export async function voidMoneyMovement(
  tenantId: string,
  id: string,
  opts: { voidedByUserId: string; reason?: string | null },
): Promise<{ ok: true } | { ok: false; reason: "NOT_FOUND" | "ALREADY_VOIDED" }> {
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ voidedAt: moneyMovements.voidedAt })
      .from(moneyMovements)
      .where(and(eq(moneyMovements.tenantId, tenantId), eq(moneyMovements.id, id)))
      .limit(1);
    if (!existing) return { ok: false, reason: "NOT_FOUND" } as const;
    if (existing.voidedAt) return { ok: false, reason: "ALREADY_VOIDED" } as const;

    await tx
      .update(moneyMovements)
      .set({
        voidedAt: new Date(),
        voidedByUserId: opts.voidedByUserId,
        voidReason: opts.reason ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(moneyMovements.tenantId, tenantId), eq(moneyMovements.id, id)));
    return { ok: true } as const;
  });
}
