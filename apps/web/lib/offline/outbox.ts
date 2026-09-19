"use client";

import {
  getOfflineDb,
  type OutboxRow,
  type OutboxStatus,
} from "./db";

// Outbox client — the only sanctioned path for queueing and draining
// offline mutations. Components never touch Dexie directly; they call
// these helpers so the shape, status transitions, and retry semantics
// stay in one place.
//
// Sync semantics:
//   - `pending`  → fresh, never tried yet.
//   - `syncing`  → an in-flight POST is racing for it. Drainer claims the
//                  row by transitioning to syncing before sending so a
//                  second drain cycle can't double-post.
//   - `synced`   → server returned 2xx. Kept around for ~1 minute so the
//                  UI can confirm; then purged in the next drain.
//   - `failed`   → server returned 4xx (non-retryable). Kept until the
//                  owner manually inspects + clears.

const SYNCED_TTL_MS = 60_000; // keep "synced" rows for 60s for UI confirmation
const MAX_ATTEMPTS = 8;

export interface EnqueueInput {
  type: "sale";
  idempotencyKey: string;
  tenantId: string;
  branchId: string;
  payload: unknown;
}

/** Append a row to the outbox in `pending` state. Returns the row id. */
export async function enqueue(input: EnqueueInput): Promise<number> {
  const db = getOfflineDb();
  const now = Date.now();
  return db.outbox.add({
    type: input.type,
    idempotencyKey: input.idempotencyKey,
    tenantId: input.tenantId,
    branchId: input.branchId,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/** Count rows by status — drives the topbar badge. */
export async function counts(): Promise<Record<OutboxStatus, number>> {
  const db = getOfflineDb();
  const all = await db.outbox.toArray();
  const out: Record<OutboxStatus, number> = {
    pending: 0,
    syncing: 0,
    synced: 0,
    failed: 0,
  };
  for (const r of all) out[r.status] += 1;
  return out;
}

/** All rows, newest first — used by the offline-indicator dropdown. */
export async function listAll(): Promise<OutboxRow[]> {
  const db = getOfflineDb();
  return db.outbox.orderBy("createdAt").reverse().toArray();
}

interface SyncOptions {
  /** Optional override (mainly for tests). Defaults to navigator.onLine. */
  isOnline?: boolean;
}

interface DrainResult {
  attempted: number;
  synced: number;
  failed: number;
}

/**
 * Drain pending outbox rows by POSTing each one to the server. Idempotent
 * across calls — concurrent invocations both no-op safely because we
 * claim a row by atomically transitioning `pending → syncing` first.
 *
 * Caller is expected to invoke this on:
 *   - `online` window event,
 *   - `visibilitychange` (focus),
 *   - and a polling tick (every ~30s) as belt-and-braces.
 */
export async function drainOutbox(
  opts: SyncOptions = {},
): Promise<DrainResult> {
  const isOnline = opts.isOnline ?? navigator.onLine;
  if (!isOnline) return { attempted: 0, synced: 0, failed: 0 };

  const db = getOfflineDb();
  // Garbage-collect old `synced` rows first.
  const cutoff = Date.now() - SYNCED_TTL_MS;
  await db.outbox.where("status").equals("synced").and((r) => r.updatedAt < cutoff).delete();

  const pending = await db.outbox
    .where("status")
    .equals("pending")
    .sortBy("createdAt");

  let synced = 0;
  let failed = 0;

  for (const row of pending) {
    if (row.id == null) continue;
    // Claim the row so a second drainer can't double-post.
    const claimed = await db.outbox
      .where({ id: row.id, status: "pending" })
      .modify({ status: "syncing", updatedAt: Date.now() });
    if (claimed === 0) continue; // another tab grabbed it

    const url = endpointFor(row.type);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": row.idempotencyKey,
          // Server validates the cookie still names this tenant + branch;
          // in multi-store the cashier could have switched branches mid-
          // shift, so we also tag the request with the branch the sale
          // was actually rung up at and the route refuses on mismatch.
          "X-Outbox-Branch": row.branchId,
        },
        body: JSON.stringify(row.payload),
      });
      if (res.ok || res.status === 200) {
        const body = await res.json().catch(() => null);
        await db.outbox.update(row.id, {
          status: "synced",
          syncedResponse: body,
          updatedAt: Date.now(),
        });
        synced += 1;
      } else if (res.status >= 400 && res.status < 500) {
        // 4xx = client error, no point retrying. Stash and surface to UI.
        const body = await res.json().catch(() => ({}));
        await db.outbox.update(row.id, {
          status: "failed",
          attempts: row.attempts + 1,
          lastError:
            (body as { error?: string }).error ?? `HTTP ${res.status}`,
          updatedAt: Date.now(),
        });
        failed += 1;
      } else {
        // 5xx / network error — bump attempts, reset to pending. Capped
        // attempt count so a permanently broken row doesn't loop forever.
        const attempts = row.attempts + 1;
        await db.outbox.update(row.id, {
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          lastError: `HTTP ${res.status}`,
          updatedAt: Date.now(),
        });
        if (attempts >= MAX_ATTEMPTS) failed += 1;
      }
    } catch (err) {
      // Network failure — same backoff as 5xx.
      const attempts = row.attempts + 1;
      await db.outbox.update(row.id, {
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts,
        lastError: err instanceof Error ? err.message : "network error",
        updatedAt: Date.now(),
      });
      if (attempts >= MAX_ATTEMPTS) failed += 1;
    }
  }

  return { attempted: pending.length, synced, failed };
}

/** Drop a single row (used by the UI's "discard failed sale" action). */
export async function discard(id: number): Promise<void> {
  const db = getOfflineDb();
  await db.outbox.delete(id);
}

/** Reset a `failed` row back to pending (for the manual retry button). */
export async function retry(id: number): Promise<void> {
  const db = getOfflineDb();
  await db.outbox.update(id, {
    status: "pending",
    attempts: 0,
    lastError: undefined,
    updatedAt: Date.now(),
  });
}

function endpointFor(type: OutboxRow["type"]): string {
  switch (type) {
    case "sale":
      return "/api/sales/cart";
  }
}
