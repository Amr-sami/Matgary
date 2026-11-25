import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { aiPendingActions, type AiPendingActionRow } from "@/lib/db/schema";

/**
 * F5 — Pending-action lifecycle for destructive AI operations.
 *
 * Contract:
 *   • `createPending()` stores the server-side truth of what the user is
 *     about to confirm. Returns an opaque token (`${id}.${hmacPrefix}`) the
 *     mobile client posts back to /api/ai/confirm.
 *   • `consumePending()` atomically marks the row consumed if and only if the
 *     token's HMAC is valid AND it hasn't expired AND it hasn't been consumed
 *     before. Uses UPDATE ... WHERE consumed_at IS NULL RETURNING to prevent
 *     TOCTOU replay — if two requests race, only one gets the row back.
 *
 * The HMAC is computed server-side with `AUTH_SECRET` as the key. The stored
 * `hmac` column covers every field that affects execution (id, tenant, user,
 * branch, action, canonical(params), expiresAt), so a row mutated out-of-band
 * will fail verification and refuse to execute.
 *
 * The client NEVER supplies parameters at execute time. `consumePending()`
 * returns the server-validated row; the executor reads params from there.
 */

const TTL_SEC = 5 * 60; // 5 minutes

export type AiActionType =
  | "update_product_price"
  | "update_product_quantity"
  | "create_customer"
  // F10.0 — reversible-operation undo rides the same pending-action pipeline.
  | "rollback"
  // F10.1 — bulk import execution rides the same pipeline.
  | "import"
  // F10.3 — bulk ops across a filtered product set.
  | "bulk_price_update"
  | "bulk_quantity_update"
  | "bulk_threshold_update"
  // Wave 1 — catalog authoring. All reuse addProduct / updateProduct /
  // addBrand / addCategory via the F5 confirmation pipeline.
  | "create_product"
  | "update_product"
  | "create_brand"
  | "create_category"
  // Financials — Phase 7-10. Reuse createFinanceExpense / voidFinanceExpense /
  // createMoneyMovement / voidMoneyMovement / createCustomCategory /
  // archiveCategory / materializeDueRecurringExpenses via the F5 pipeline.
  | "create_expense"
  | "void_expense"
  | "create_money_movement"
  | "void_money_movement"
  | "create_finance_category"
  | "archive_finance_category"
  | "generate_recurring"
  // Phase 12 — receipt settings staged update.
  | "update_receipt_settings"
  // Task writes — wrap lib/repo/tasks.ts createTask / updateTask /
  // setTaskStatus via the F5 pipeline.
  | "create_task"
  | "update_task"
  | "set_task_status"
  // Payroll V1 — wrap lib/repo/payroll-periods.ts {upsertPayrollDraft,
  // finalizePayrollPeriod, createPayrollAdjustment} + lib/repo/payroll.ts
  // createCompensation via the F5 pipeline. All require manage_payroll and
  // are re-checked at confirm time.
  | "payroll_calculate"
  | "payroll_finalize"
  | "payroll_update_compensation"
  | "payroll_add_adjustment"
  // Phase B P0 — composite purchase (create + receive + optional payment),
  // and standalone supplier payment on a specific received PO. Both wrap
  // authoritative lib/repo/purchase-orders.ts + lib/repo/purchase-payments.ts
  // via the F5 pipeline. Both require `manage_purchases`.
  | "create_purchase"
  | "record_purchase_payment"
  // Supplier Account Payment Correction — the DEFAULT interpretation of
  // "دفعت لمورد X Y جنيه" when the user does NOT name a specific invoice.
  // Wraps lib/repo/supplier-account-payment.recordSupplierAccountPayment,
  // which composes money_movements(kind=supplier_payment_direct) +
  // adjustSupplierBalance in one tx. Still `manage_purchases`.
  | "record_supplier_account_payment";

export interface CreatePendingInput {
  tenantId: string;
  userId: string;
  branchId: string | null;
  action: AiActionType;
  /** Executor-shaped params. Captured verbatim; canonical JSON goes into the HMAC. */
  params: Record<string, unknown>;
  /** UI hint — what the user is about to confirm. Executor ignores. */
  preview: Record<string, unknown>;
  /** Override TTL for tests. */
  ttlSec?: number;
}

export interface PendingToken {
  /** Row id. Doubles as the opaque "token" the mobile client presents. */
  id: string;
  /** ISO8601. Mobile UI shows a countdown. */
  expiresAt: string;
  /** Opaque "token" string sent to the client: `${id}.${fullHmac}`. We ship
   *  the FULL 64-hex-char SHA-256 MAC — a 16-char prefix leaves only 64 bits
   *  of search entropy, which is not enough for an ERP mutation authorization
   *  token (F5.1 §2). The id itself is a v4 uuid, so the full token is
   *  ~36+1+64 = 101 chars. */
  token: string;
}

export async function createPending(input: CreatePendingInput): Promise<PendingToken> {
  const secret = requireSecret();
  const expiresAt = new Date(Date.now() + (input.ttlSec ?? TTL_SEC) * 1000);

  return withTenant(input.tenantId, async (tx) => {
    // Insert with a placeholder hmac; we need the id to sign over, and
    // Postgres generates it. Round-trip: insert → compute hmac over the
    // returned id + inputs → update hmac in place. Both in one transaction.
    const [row] = await tx
      .insert(aiPendingActions)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        branchId: input.branchId,
        action: input.action,
        params: input.params,
        preview: input.preview,
        hmac: "pending",
        expiresAt,
      })
      .returning();
    if (!row) throw new Error("ai_pending_actions insert returned no row");

    const hmac = signPending(secret, row);
    await tx
      .update(aiPendingActions)
      .set({ hmac })
      .where(eq(aiPendingActions.id, row.id));

    return {
      id: row.id,
      expiresAt: expiresAt.toISOString(),
      // Full 64-char HMAC. Previously we shipped a 16-char prefix, which was
      // the only part verified at consume time — that's only 64 bits of
      // entropy, borderline brute-forceable if an attacker had many parallel
      // attempts. Full HMAC takes the search space to 2^256.
      token: `${row.id}.${hmac}`,
    };
  });
}

export interface ConsumeInput {
  tenantId: string;
  userId: string;
  token: string;
}

export type ConsumeResult =
  | { ok: true; row: AiPendingActionRow }
  | {
      ok: false;
      reason:
        | "INVALID_TOKEN"
        | "NOT_FOUND"
        | "EXPIRED"
        | "ALREADY_CONSUMED"
        | "TENANT_MISMATCH"
        | "USER_MISMATCH"
        | "HMAC_MISMATCH";
    };

export async function consumePending(input: ConsumeInput): Promise<ConsumeResult> {
  const secret = requireSecret();
  const parsed = parseToken(input.token);
  if (!parsed) return { ok: false, reason: "INVALID_TOKEN" };

  return withTenant(input.tenantId, async (tx) => {
    // Atomic one-time-use: the UPDATE only matches rows that are still
    // unconsumed AND not expired AND belong to this tenant. If two requests
    // race, Postgres awards the row to exactly one.
    const now = new Date();
    // `expires_at` is timestamptz — pass an ISO string so postgres-js doesn't
    // serialize with the Node locale ("Sun Nov 08 2026 … GMT+0200") which
    // some drivers reject.
    const nowIso = now.toISOString();
    const [row] = await tx
      .update(aiPendingActions)
      .set({ consumedAt: now })
      .where(
        and(
          eq(aiPendingActions.id, parsed.id),
          eq(aiPendingActions.tenantId, input.tenantId),
          isNull(aiPendingActions.consumedAt),
          sql`${aiPendingActions.expiresAt} > ${nowIso}::timestamptz`,
        ),
      )
      .returning();
    if (!row) {
      // Row didn't match. Could be any of: not found, wrong tenant, expired,
      // already consumed. Diagnose for a better user-facing message.
      const [probe] = await tx
        .select()
        .from(aiPendingActions)
        .where(eq(aiPendingActions.id, parsed.id));
      if (!probe) return { ok: false, reason: "NOT_FOUND" };
      if (probe.tenantId !== input.tenantId) return { ok: false, reason: "TENANT_MISMATCH" };
      if (probe.consumedAt) return { ok: false, reason: "ALREADY_CONSUMED" };
      if (probe.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "EXPIRED" };
      return { ok: false, reason: "NOT_FOUND" };
    }
    if (row.userId !== input.userId) {
      // A different user confirmed someone else's action. Row is now consumed,
      // which is fine — the attacker can't reuse it either.
      return { ok: false, reason: "USER_MISMATCH" };
    }
    const expectedFull = signPending(secret, row);
    // Full-length constant-time compare only — F5.1 §2 removed the 16-char
    // prefix fallback.
    if (!constantTimeEquals(expectedFull, parsed.rawHmac)) {
      return { ok: false, reason: "HMAC_MISMATCH" };
    }
    return { ok: true, row };
  });
}

/* ──────────────────────────── crypto helpers ──────────────────────────── */

function requireSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set; AI write confirmation is disabled.");
  return s;
}

/** Deterministic canonical JSON — same input, same output across runs.
 *  Object keys are sorted; arrays preserved as-is. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

export function signPending(secret: string, row: Pick<AiPendingActionRow, "id" | "tenantId" | "userId" | "branchId" | "action" | "params" | "expiresAt">): string {
  const message = [
    row.id,
    row.tenantId,
    row.userId,
    row.branchId ?? "",
    row.action,
    canonicalJson(row.params),
    row.expiresAt.toISOString(),
  ].join("|");
  return createHmac("sha256", secret).update(message).digest("hex");
}

function parseToken(token: string): { id: string; rawHmac: string } | null {
  const i = token.indexOf(".");
  if (i < 0) return null;
  const id = token.slice(0, i);
  const rawHmac = token.slice(i + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (!/^[0-9a-f]+$/i.test(rawHmac)) return null;
  return { id, rawHmac };
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
