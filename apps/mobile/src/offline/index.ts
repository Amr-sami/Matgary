/**
 * Offline engine — public API. Everything a feature needs is exported here;
 * do not import from ./outbox, ./db or ./schema directly.
 *
 * WRITE PATH (queue-then-send)
 *   registerHandler("sale", async (payload, idempotencyKey) =>
 *     api.request("/api/sales/cart", {
 *       method: "POST", body: payload,
 *       headers: { "Idempotency-Key": idempotencyKey },   // ← the server dedupes on this
 *     }))
 *   Call it at MODULE scope of the feature's endpoint file so the handler
 *   exists before the launch drain runs. Throw ApiError (api.request does)
 *   and the engine classifies: network/5xx/429 → backoff + retry;
 *   401/402/TOTP → pause until signed in; 4xx validation → `failed` for a
 *   human (see classify.ts).
 *
 *   const id = enqueue("sale", body, idempotencyKey);   // sync, returns row id
 *   Mint `idempotencyKey` ONCE (e.g. randomUUID()) and store it with the
 *   cart before calling; enqueue dedupes on it, so a double-tap is harmless.
 *   It MUST match /^[A-Za-z0-9_-]{8,64}$/ (IDEMPOTENCY_KEY_RE) — the server
 *   silently ignores any other shape — and enqueue THROWS on a bad one.
 *   Enqueue also throws when nobody is signed in: every row is stamped with
 *   the session's tenant/user/branch (§6.1) and the handler receives
 *   `row.branchId` to send as X-Outbox-Branch (§6.5).
 *   Never tell the user the sale is synced — it is queued (§6.4). Watch the
 *   row: useOutbox().find(r => r.id === id)?.status === "done".
 *
 *   Failure codes the ENGINE writes to `lastErrorCode` (no server text):
 *   NO_HANDLER, BAD_PAYLOAD, EXCEPTION, MAX_ATTEMPTS — the sync screen maps
 *   them to t("mobile.offline.error.<code>"); everything else is the
 *   server's own code, with its message in `lastErrorText`.
 *
 *   drainNow("manual")     — the sync screen's button; resolves with DrainResult.
 *   retry(id) / retryAllFailed() / discard(id)  — discard REQUIRES a confirm
 *   dialog in the caller (§6.6) and writes an audit copy before deleting.
 *
 * READ PATH (last good answer)
 *   saveSnapshot("products:<branch>", data)  after a successful fetch
 *   readSnapshot<T>(key) → { data, updatedAt } | null   before/instead of one
 *   Keys are prefixed with the signed-in tenant id by the engine, and the
 *   engine wipes every snapshot on sign-out (explicit or dead session) —
 *   nobody else needs to call clearSnapshots() (§5.5). Show `updatedAt` to
 *   the user when it is old; never block on it.
 *
 * SHARED TABLET
 *   Outbox rows of a signed-out account stay on disk, hidden and unsent,
 *   until that account signs in again on this device; they are never sent
 *   under another bearer and never deleted by the engine.
 *
 * UI
 *   useOffline()  — zustand: { online, draining, queued, failed, lastSyncedAt, lastError, paused }
 *   useOutbox()   — the row list, re-read whenever any row changes
 *   touchLastSynced() — call after any successful read so the chip's "last synced" is honest
 */
import { useMemo } from "react";

import { useOffline } from "@/stores/offline";

import { list as listRows, drain, type DrainReason, type DrainResult, type OutboxItem } from "./outbox";

export {
  enqueue,
  registerHandler,
  hasHandler,
  list,
  get,
  counts,
  retry,
  retryAllFailed,
  discard,
  touchLastSynced,
  IDEMPOTENCY_KEY_RE,
  MAX_ATTEMPTS,
  type OutboxHandler,
  type OutboxItem,
  type DrainReason,
  type DrainResult,
} from "./outbox";
export { saveSnapshot, readSnapshot, deleteSnapshot, clearSnapshots, type Snapshot } from "./snapshots";
export { classifyOutcome, type Outcome } from "./classify";
export type { OutboxStatus } from "./schema";
export { useOffline } from "@/stores/offline";

/** Run a drain pass now. Single-flight: concurrent callers share one pass. */
export function drainNow(reason: DrainReason = "manual"): Promise<DrainResult> {
  return drain(reason);
}

/** The queue as a live list (newest first). Re-renders on every row change. */
export function useOutbox<P = unknown, R = unknown>(): OutboxItem<P, R>[] {
  const revision = useOffline((s) => s.revision);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => listRows() as OutboxItem<P, R>[], [revision]);
}
