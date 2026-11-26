import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  customerWallets,
  customerWalletEvents,
} from "@/lib/db/schema";

// Loyalty + store-credit repo. One wallet per (tenant, branch, phone).
// Every mutation goes through these helpers so:
//   - The events log captures the source (sale / return / actor).
//   - Balance + event are written in the same tx — no half-applied changes.
//   - Negative balances are refused at write time (server is the source
//     of truth, even if a client hands us stale numbers).
//
// All mutators are designed to be called *inside* a `withTenant` tx by
// the sale-recording flow, so they take the tx as the first arg. The
// reader + the standalone "owner grants credit" path open their own tx.

export type WalletEventKind =
  | "points_earn"
  | "points_redeem"
  | "points_expire"
  | "credit_grant"
  | "credit_redeem"
  | "credit_refund"
  | "credit_deduct";

export interface WalletDto {
  customerPhone: string;
  customerName: string | null;
  points: number;
  credit: number;
  updatedAt: Date;
}

export interface WalletEventDto {
  id: string;
  kind: WalletEventKind;
  pointsDelta: number;
  creditDelta: number;
  relatedSaleId: string | null;
  relatedReturnId: string | null;
  actorUserId: string | null;
  reason: string | null;
  createdAt: Date;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

// ─────────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read wallet + recent events for one customer. Returns a wallet with
 * zero balances when no row exists yet (lets the cart UI render
 * consistently without an extra "create wallet" step).
 */
export async function getWallet(
  tenantId: string,
  branchId: string,
  customerPhone: string,
  options: { eventLimit?: number } = {},
): Promise<{ wallet: WalletDto; events: WalletEventDto[] }> {
  const eventLimit = Math.max(1, Math.min(500, options.eventLimit ?? 100));
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(customerWallets)
      .where(
        and(
          eq(customerWallets.tenantId, tenantId),
          eq(customerWallets.branchId, branchId),
          eq(customerWallets.customerPhone, customerPhone),
        ),
      )
      .limit(1);

    const wallet: WalletDto = row
      ? {
          customerPhone: row.customerPhone,
          customerName: row.customerName,
          points: row.points,
          credit: Number(row.credit),
          updatedAt: row.updatedAt,
        }
      : {
          customerPhone,
          customerName: null,
          points: 0,
          credit: 0,
          updatedAt: new Date(0),
        };

    const events = await tx
      .select()
      .from(customerWalletEvents)
      .where(
        and(
          eq(customerWalletEvents.tenantId, tenantId),
          eq(customerWalletEvents.branchId, branchId),
          eq(customerWalletEvents.customerPhone, customerPhone),
        ),
      )
      .orderBy(desc(customerWalletEvents.createdAt))
      .limit(eventLimit);

    return {
      wallet,
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind as WalletEventKind,
        pointsDelta: e.pointsDelta,
        creditDelta: Number(e.creditDelta),
        relatedSaleId: e.relatedSaleId,
        relatedReturnId: e.relatedReturnId,
        actorUserId: e.actorUserId,
        reason: e.reason,
        createdAt: e.createdAt,
      })),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutators (in-tx — called from the sale flow)
// ─────────────────────────────────────────────────────────────────────────────

interface BaseMutationCtx {
  tenantId: string;
  branchId: string;
  customerPhone: string;
  /** Snapshot of the customer's name at this transaction. Stored on the
   *  wallet row so the wallet UI doesn't need to join sales. */
  customerName?: string | null;
  actorUserId?: string | null;
  relatedSaleId?: string | null;
  relatedReturnId?: string | null;
  reason?: string | null;
}

/**
 * Internal helper — upsert the wallet row and apply signed deltas. Refuses
 * to make either balance negative. Returns the new balances post-update.
 */
async function applyWalletDelta(
  tx: Tx,
  ctx: BaseMutationCtx,
  pointsDelta: number,
  creditDelta: number,
): Promise<{ points: number; credit: number }> {
  // Read current row (or default to zeros).
  const [existing] = await tx
    .select()
    .from(customerWallets)
    .where(
      and(
        eq(customerWallets.tenantId, ctx.tenantId),
        eq(customerWallets.branchId, ctx.branchId),
        eq(customerWallets.customerPhone, ctx.customerPhone),
      ),
    )
    .limit(1);

  const currentPoints = existing?.points ?? 0;
  const currentCredit = Number(existing?.credit ?? 0);
  const nextPoints = currentPoints + pointsDelta;
  const nextCredit = currentCredit + creditDelta;

  if (nextPoints < 0) {
    throw new Error(
      `رصيد النقاط غير كافٍ (المتاح ${currentPoints}، المطلوب ${-pointsDelta}).`,
    );
  }
  if (nextCredit < 0) {
    throw new Error(
      `رصيد العميل غير كافٍ (المتاح ${currentCredit.toFixed(2)} ج.م).`,
    );
  }

  if (existing) {
    await tx
      .update(customerWallets)
      .set({
        points: nextPoints,
        credit: nextCredit.toFixed(2),
        // Refresh the cached name when the caller passed one.
        ...(ctx.customerName ? { customerName: ctx.customerName } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerWallets.tenantId, ctx.tenantId),
          eq(customerWallets.branchId, ctx.branchId),
          eq(customerWallets.customerPhone, ctx.customerPhone),
        ),
      );
  } else {
    await tx.insert(customerWallets).values({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      customerPhone: ctx.customerPhone,
      customerName: ctx.customerName ?? null,
      points: nextPoints,
      credit: nextCredit.toFixed(2),
    });
  }

  return { points: nextPoints, credit: nextCredit };
}

/** Write an event row. Doesn't touch the wallet — pair with applyWalletDelta. */
async function writeEvent(
  tx: Tx,
  ctx: BaseMutationCtx,
  kind: WalletEventKind,
  pointsDelta: number,
  creditDelta: number,
): Promise<void> {
  await tx.insert(customerWalletEvents).values({
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    customerPhone: ctx.customerPhone,
    kind,
    pointsDelta,
    creditDelta: creditDelta.toFixed(2),
    relatedSaleId: ctx.relatedSaleId ?? null,
    relatedReturnId: ctx.relatedReturnId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    reason: ctx.reason ?? null,
  });
}

/** Award points after a successful sale. `points` must be >= 0. */
export async function earnPoints(
  tx: Tx,
  ctx: BaseMutationCtx,
  points: number,
): Promise<{ points: number; credit: number }> {
  if (points <= 0) {
    // Nothing to do, but still return the current balances for the caller.
    return applyWalletDelta(tx, ctx, 0, 0);
  }
  const next = await applyWalletDelta(tx, ctx, points, 0);
  await writeEvent(tx, ctx, "points_earn", points, 0);
  return next;
}

/** Redeem points at the cart. Refused if balance is short. */
export async function redeemPoints(
  tx: Tx,
  ctx: BaseMutationCtx,
  points: number,
): Promise<{ points: number; credit: number }> {
  if (points <= 0) return applyWalletDelta(tx, ctx, 0, 0);
  const next = await applyWalletDelta(tx, ctx, -points, 0);
  await writeEvent(tx, ctx, "points_redeem", -points, 0);
  return next;
}

/** Apply EGP credit at the cart. Refused if balance is short. */
export async function applyCredit(
  tx: Tx,
  ctx: BaseMutationCtx,
  amountEgp: number,
): Promise<{ points: number; credit: number }> {
  if (amountEgp <= 0) return applyWalletDelta(tx, ctx, 0, 0);
  const next = await applyWalletDelta(tx, ctx, 0, -amountEgp);
  await writeEvent(tx, ctx, "credit_redeem", 0, -amountEgp);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone mutators (open their own tx — used by manual owner actions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Owner manually grants store credit to a customer. Reason is required so
 * the event log makes sense to anyone reading it later. Pass a negative
 * `amountEgp` to deduct (e.g. correcting a mistaken grant) — it'll fail
 * if it would put the wallet underwater.
 */
export async function grantCredit(
  tenantId: string,
  branchId: string,
  customerPhone: string,
  amountEgp: number,
  options: {
    customerName?: string | null;
    actorUserId: string;
    reason: string;
  },
): Promise<{ points: number; credit: number }> {
  if (!options.reason.trim()) {
    throw new Error("سبب الإضافة مطلوب");
  }
  return withTenant(tenantId, async (tx) => {
    const next = await applyWalletDelta(
      tx,
      {
        tenantId,
        branchId,
        customerPhone,
        customerName: options.customerName,
        actorUserId: options.actorUserId,
        reason: options.reason.trim(),
      },
      0,
      amountEgp,
    );
    await writeEvent(
      tx,
      {
        tenantId,
        branchId,
        customerPhone,
        customerName: options.customerName,
        actorUserId: options.actorUserId,
        reason: options.reason.trim(),
      },
      amountEgp >= 0 ? "credit_grant" : "credit_deduct",
      0,
      amountEgp,
    );
    return next;
  });
}
