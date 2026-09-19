// Receipt drain — the prune mechanism the spec names (doc 06 §8.2).
//
// A send returns a TICKET at once; the RECEIPT — did APNs/FCM actually take
// it? — lands minutes later. `DeviceNotRegistered` at ticket level only
// covers tokens Expo already knows are dead; a real uninstall is only ever
// reported in the receipt. Without this drain a dead device is pushed to
// forever, and Expo warns that APNs/FCM throttle senders who keep doing so.
//
// `handleOutcomes` queues every `ok` ticket in `push_receipts`. The cron
// (app/api/cron/digest-tick) calls `drainPushReceipts` each tick: rows at
// least RECEIPT_DELAY_MS old are looked up in one getReceipts call per
// tenant, dead tokens are disabled, checked rows are deleted. A ticket Expo
// has no receipt for yet stays queued for the next tick; one older than
// RECEIPT_TTL_MS is dropped unread (Expo keeps receipts for 24 h).
//
// Per tenant because `push_receipts` is under RLS like every tenant table —
// the drain has no business reading across shops in one statement.

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import { pushReceipts, tenants } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

import { getReceipts, type SendPushOptions } from "./expo-push";
import { disableTokens } from "./notify";

/** Wait this long after the ticket before asking for its receipt. */
export const RECEIPT_DELAY_MS = 15 * 60 * 1000;
/** Give up on a receipt Expo never produced. */
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
/** Rows per tenant per tick — one getReceipts request. */
export const RECEIPT_BATCH = 1000;

export interface DrainResult {
  tenants: number;
  checked: number;
  disabled: number;
  /** Queued rows Expo has no receipt for yet (retried next tick). */
  pending: number;
  /** Rows dropped unread because they passed RECEIPT_TTL_MS. */
  expired: number;
}

export interface DrainOptions extends SendPushOptions {
  /** Test seam: "now". */
  now?: Date;
}

const empty = (): DrainResult => ({ tenants: 0, checked: 0, disabled: 0, pending: 0, expired: 0 });

/** Drain every tenant's queue. Never throws — one bad tenant is logged and
 *  the rest still run. */
export async function drainPushReceipts(opts: DrainOptions = {}): Promise<DrainResult> {
  const total = empty();
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(sql`${tenants.suspendedAt} IS NULL`);
  for (const t of rows) {
    try {
      const r = await drainTenantReceipts(t.id, opts);
      total.tenants += 1;
      total.checked += r.checked;
      total.disabled += r.disabled;
      total.pending += r.pending;
      total.expired += r.expired;
    } catch (err) {
      logger.error({
        event: "push.receipts_drain_failed",
        tenantId: t.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (total.checked + total.expired > 0) {
    logger.info({ event: "push.receipts_drained", ...total });
  }
  return total;
}

/** Drain one tenant's queue. Exported for tests and for a targeted re-run. */
export async function drainTenantReceipts(
  tenantId: string,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const dueBefore = new Date(now.getTime() - RECEIPT_DELAY_MS);
  const expiredBefore = new Date(now.getTime() - RECEIPT_TTL_MS);
  const result = { ...empty(), tenants: 1 };

  // 1) Everything old enough to have a receipt, oldest first.
  const due = await withTenant(tenantId, (tx) =>
    tx
      .select({
        id: pushReceipts.id,
        ticketId: pushReceipts.ticketId,
        expoToken: pushReceipts.expoToken,
        userId: pushReceipts.userId,
        createdAt: pushReceipts.createdAt,
      })
      .from(pushReceipts)
      .where(and(eq(pushReceipts.tenantId, tenantId), lt(pushReceipts.createdAt, dueBefore)))
      .orderBy(pushReceipts.createdAt)
      .limit(RECEIPT_BATCH),
  );
  if (due.length === 0) return result;

  // 2) One round-trip to Expo for the whole batch.
  const receipts = await getReceipts(
    due.map((r) => r.ticketId),
    opts,
  );

  // 3) Sort the batch: answered → delete (+ disable if dead); unanswered →
  //    keep unless expired.
  const done: string[] = [];
  const dead = new Set<string>();
  for (const row of due) {
    const receipt = receipts.get(row.ticketId);
    if (receipt) {
      done.push(row.id);
      result.checked += 1;
      if (receipt.status === "error") {
        if (receipt.details?.error === "DeviceNotRegistered") {
          dead.add(row.expoToken);
        } else {
          logger.warn({
            event: "push.receipt_error",
            tenantId,
            userId: row.userId,
            to: row.expoToken.slice(0, 24) + "…",
            error: receipt.details?.error ?? null,
            message: receipt.message ?? null,
          });
        }
      }
    } else if (row.createdAt < expiredBefore) {
      done.push(row.id);
      result.expired += 1;
    } else {
      result.pending += 1;
    }
  }

  if (dead.size > 0) {
    result.disabled = await disableTokens(tenantId, [...dead]);
    logger.info({ event: "push.tokens_disabled", tenantId, count: result.disabled, via: "receipt" });
  }
  if (done.length > 0) {
    await withTenant(tenantId, async (tx) => {
      await tx.delete(pushReceipts).where(inArray(pushReceipts.id, done));
    });
  }
  return result;
}
