/**
 * The durable write queue. Every mutation a cashier can make with no signal
 * — sale, return, attendance check-in … — is a row here first and a network
 * request second. See doc 06 §6.3 for the four web defects this fixes and
 * §6.6 for the three things that must never happen.
 *
 * Invariants (tested by reading, since SQLite cannot run under node):
 *  - A row is never deleted by the engine. Only `discard()` deletes, after
 *    writing an audit copy to `meta`.
 *  - One drain at a time (module-level promise). Only `drain()` invokes
 *    handlers, and it claims a row with `UPDATE … WHERE status = 'queued'`
 *    before sending, so the same idempotency key is never in flight twice.
 *  - `markDone` runs synchronously the moment the handler resolves, before
 *    the loop can look at the next row.
 *  - The idempotency key is written once at enqueue and never touched again.
 *  - Every row is stamped with its tenant/user/branch at enqueue (§6.1).
 *    All reads and the drain are fenced to the signed-in tenant: another
 *    account's rows stay queued and hidden — never sent under its bearer,
 *    never deleted — until that account signs in again on this device.
 */
import { and, asc, desc, eq, lt, lte, sql, type SQL } from "drizzle-orm";
import type { MeResponse } from "@matgary/api-client";

import { useOffline } from "@/stores/offline";
import { useSession } from "@/stores/session";

import { classifyOutcome, isErrorLike } from "./classify";
import { getDb, getSqlite } from "./db";
import { outbox, meta, type OutboxRow, type OutboxStatus } from "./schema";
import { clearSnapshots } from "./snapshots";

/** A feature's sender. Throw an ApiError (or anything) to have the engine decide. */
export type OutboxHandler<P = unknown, R = unknown> = (
  payload: P,
  idempotencyKey: string,
  row: {
    id: string;
    kind: string;
    attempts: number;
    tenantId: string;
    userId: string | null;
    /** Send as `X-Outbox-Branch` so a row rung at branch A is refused, not booked, at B (§6.5). */
    branchId: string | null;
  },
) => Promise<R>;

export type DrainReason =
  | "launch"
  | "enqueue"
  | "foreground"
  | "reconnect"
  | "interval"
  | "background"
  | "session"
  | "manual"
  | "retry";

export interface DrainResult {
  reason: DrainReason;
  /** False when the drain did not run (offline, signed out, paused, or piggy-backed). */
  ran: boolean;
  sent: number;
  failed: number;
  deferred: number;
}

/** `list()` row — payload/response already parsed. */
export interface OutboxItem<P = unknown, R = unknown> {
  id: string;
  kind: string;
  payload: P;
  idempotencyKey: string;
  /** Owner stamp — the signed-in tenant/user/branch at enqueue (§6.1). */
  tenantId: string | null;
  userId: string | null;
  branchId: string | null;
  status: OutboxStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorText: string | null;
  /** True when the cashier can resolve the failure (stock, product, branch). */
  actionable: boolean;
  response: R | null;
}

const LEASE_MS = 60_000;
/** Done rows are kept this long so a receipt can still show "synced". */
const DONE_TTL_MS = 24 * 60 * 60_000;
/** One request/second: the tenant write limiter is 60/min (apps/web/lib/api/tenant-rate-limit.ts). */
const PACE_MS = 1_000;
/** A row the server refused this many times is parked as `failed` for a human (§6.3). */
export const MAX_ATTEMPTS = 50;
/** An auth/billing pause lifts by itself after this long, so a wall cleared server-side is noticed without a tap. */
const PAUSE_TTL_MS = 5 * 60_000;
/** The only key shape the server dedupes on (apps/web/lib/api/idempotency.ts); anything else is silently ignored. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** When a row's kind has no handler yet (feature module not loaded), look again soon. */
const NO_HANDLER_DEFER_MS = 30_000;

const handlers = new Map<string, OutboxHandler>();

let initialised = false;
let inflight: Promise<DrainResult> | null = null;
let rerun: DrainReason | null = null;

// ─── owner fence ─────────────────────────────────────────────────────────────

interface Owner {
  tenantId: string;
  userId: string;
  branchId: string | null;
}

/** The signed-in tenant/user/branch, or null when nobody is signed in. */
function owner(): Owner | null {
  const me = useSession.getState().me;
  if (!me) return null;
  return { tenantId: me.tenant.id, userId: me.user.id, branchId: me.branch.id };
}

/** WHERE fragment restricting a query to the signed-in tenant's rows; null when signed out. */
function tenantScope(): SQL | null {
  const tenant = useSession.getState().me?.tenant.id;
  return tenant ? eq(outbox.tenantId, tenant) : null;
}

/** True when /me states a wall the drain would only bounce off. */
function behindWall(me: MeResponse): boolean {
  return me.tenant.suspended || !me.tenant.subscriptionAccessActive || me.user.mustChangePassword === true;
}

function unpause() {
  useOffline.getState().set({ paused: null, pausedAt: null, pausedCode: null });
}

/**
 * Sign-out — explicit, or the client's dead-session path; both flip the
 * store to signedOut — wipes the read cache so a shared tablet never shows
 * the next account the previous shop's products (§5.5). Outbox rows are NOT
 * touched: the tenant fence hides them, and they resume when their owner
 * signs back in.
 */
function onSignedOut() {
  clearSnapshots();
  useOffline.getState().set({ paused: null, pausedAt: null, pausedCode: null, lastError: null });
  publish();
}

useSession.subscribe((s, prev) => {
  if (prev.status === "signedIn" && s.status !== "signedIn") {
    onSignedOut();
    return;
  }
  // A /me refresh is how a lifted billing / suspension / password wall
  // shows up (SuspensionRouter re-reads it). The blocked store only says a
  // wall was HIT — never that it cleared — so it is not the signal to
  // resume on (it would loop: drain → 402 → raise → route → clear → drain).
  if (s.status === "signedIn" && s.me && s.me !== prev.me && useOffline.getState().paused && !behindWall(s.me)) {
    void drain("session");
  }
});

// ─── setup ───────────────────────────────────────────────────────────────────

/**
 * First touch: open the DB and reclaim every `sending` row. No drain can be
 * in flight before this module has run, so any such row was orphaned by a
 * process kill and is safe to hand back to the queue (§6.3 defect 3).
 */
function init() {
  if (initialised) return;
  initialised = true;
  const db = getDb();
  const now = Date.now();
  db.update(outbox)
    .set({ status: "queued", leaseExpiresAt: null, updatedAt: now })
    .where(eq(outbox.status, "sending"))
    .run();
  const last = readMeta("lastSyncedAt");
  // Deferred: `list()` may be the first touch, from inside a render, and a
  // store write during render is a React warning.
  queueMicrotask(() => {
    useOffline.getState().set({ lastSyncedAt: last ? Number(last) : null });
    publish();
  });
}

export function registerHandler<P, R>(kind: string, handler: OutboxHandler<P, R>) {
  handlers.set(kind, handler as OutboxHandler);
}

export function hasHandler(kind: string): boolean {
  return handlers.has(kind);
}

// ─── meta helpers (shared with snapshots.ts) ─────────────────────────────────

export function readMeta(key: string): string | null {
  const row = getDb().select().from(meta).where(eq(meta.key, key)).get();
  return row?.value ?? null;
}

export function writeMeta(key: string, value: string) {
  getDb()
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: meta.key, set: { value } })
    .run();
}

// ─── queue operations ────────────────────────────────────────────────────────

/**
 * Add a row. Returns its id. A second call with the same idempotency key is
 * a no-op that returns the EXISTING row's id — the key is the dedupe unit.
 * Kicks a drain immediately (a no-op when offline).
 *
 * Throws on a key the server would not dedupe on (IDEMPOTENCY_KEY_RE) —
 * falling back to a fresh key would silently break the caller's own
 * dedupe and charge twice on a timeout (§6.6) — and when nobody is signed
 * in, since a row without an owner could be sent under the wrong bearer.
 */
export function enqueue(
  kind: string,
  payload: unknown,
  idempotencyKey: string,
  opts: { id?: string } = {},
): string {
  init();
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new Error(`INVALID_IDEMPOTENCY_KEY: must match ${IDEMPOTENCY_KEY_RE}`);
  }
  const who = owner();
  if (!who) throw new Error("NOT_SIGNED_IN: an outbox row needs an owner to be sent as");
  const now = Date.now();
  const id = opts.id ?? `${kind}_${idempotencyKey}`;
  const db = getDb();
  db.insert(outbox)
    .values({
      id,
      kind,
      payload: JSON.stringify(payload ?? null),
      idempotencyKey,
      tenantId: who.tenantId,
      userId: who.userId,
      branchId: who.branchId,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      nextAttemptAt: 0,
      status: "queued",
    })
    .onConflictDoNothing({ target: outbox.idempotencyKey })
    .run();
  const row = db
    .select({ id: outbox.id })
    .from(outbox)
    .where(eq(outbox.idempotencyKey, idempotencyKey))
    .get();
  publish();
  void drain("enqueue");
  return row?.id ?? id;
}

/** The signed-in tenant's rows, newest first (empty when signed out). Synchronous — safe inside a render via useOutbox(). */
export function list(): OutboxItem[] {
  init();
  const scope = tenantScope();
  if (!scope) return [];
  return getDb().select().from(outbox).where(scope).orderBy(desc(outbox.createdAt)).all().map(toItem);
}

export function get(id: string): OutboxItem | null {
  init();
  const scope = tenantScope();
  if (!scope) return null;
  const row = getDb().select().from(outbox).where(and(eq(outbox.id, id), scope)).get();
  return row ? toItem(row) : null;
}

/** Counts for the badge — the signed-in tenant's rows only. */
export function counts(): { queued: number; failed: number } {
  init();
  const scope = tenantScope();
  if (!scope) return { queued: 0, failed: 0 };
  const rows = getDb()
    .select({ status: outbox.status, n: sql<number>`count(*)` })
    .from(outbox)
    .where(scope)
    .groupBy(outbox.status)
    .all();
  let queued = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.status === "queued" || r.status === "sending") queued += Number(r.n);
    else if (r.status === "failed") failed += Number(r.n);
  }
  return { queued, failed };
}

/**
 * Put a `failed` (or backed-off) row back at the front of the line and
 * drain. Attempts are reset so the backoff curve starts over; the
 * idempotency key is untouched.
 */
export function retry(id: string): Promise<DrainResult> {
  init();
  const scope = tenantScope();
  if (!scope) return Promise.resolve(skipped("retry"));
  const now = Date.now();
  getDb()
    .update(outbox)
    .set({
      status: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      leaseExpiresAt: null,
      lastError: null,
      lastErrorCode: null,
      lastErrorText: null,
      actionable: 0,
      updatedAt: now,
    })
    .where(and(eq(outbox.id, id), sql`${outbox.status} IN ('failed', 'queued')`, scope))
    .run();
  unpause();
  publish();
  return drain("retry");
}

/** Every failed row → queued, then drain. The /sync screen's "retry all". */
export function retryAllFailed(): Promise<DrainResult> {
  init();
  const scope = tenantScope();
  if (!scope) return Promise.resolve(skipped("retry"));
  const now = Date.now();
  getDb()
    .update(outbox)
    .set({
      status: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      lastErrorCode: null,
      lastErrorText: null,
      actionable: 0,
      updatedAt: now,
    })
    .where(and(eq(outbox.status, "failed"), scope))
    .run();
  unpause();
  publish();
  return drain("retry");
}

/**
 * Delete a row. The CALLER must have shown a confirm (§6.6). A copy of the
 * row is written to `meta` under `discard:<id>` first, so a discarded sale
 * can still be found by support. Refuses rows that are mid-send.
 */
export function discard(id: string): boolean {
  init();
  const scope = tenantScope();
  if (!scope) return false;
  const db = getDb();
  const row = db.select().from(outbox).where(and(eq(outbox.id, id), scope)).get();
  if (!row || row.status === "sending") return false;
  getSqlite().withTransactionSync(() => {
    writeMeta(`discard:${id}`, JSON.stringify({ ...row, discardedAt: Date.now() }));
    db.delete(outbox).where(eq(outbox.id, id)).run();
  });
  publish();
  return true;
}

// ─── the drain ───────────────────────────────────────────────────────────────

/**
 * Send what can be sent, oldest first. Single-flight: a call made while a
 * pass is running schedules exactly one more pass afterwards (so a
 * reconnect during a drain is not lost) and resolves with THAT pass's
 * result — the one that actually looks at a row retry()/drainNow()
 * requeued mid-drain, so the sync screen's spinner and counts are honest.
 */
export function drain(reason: DrainReason): Promise<DrainResult> {
  init();
  if (inflight) {
    rerun = reason;
    // By the time the current pass settles, its `finally` has already
    // started the rerun and stored it in `inflight`; the fallback covers a
    // rerun that was somehow not started.
    return inflight.then(() => inflight ?? drain(reason));
  }
  inflight = runDrain(reason).finally(() => {
    inflight = null;
    const again = rerun;
    rerun = null;
    if (again) void drain(again);
  });
  return inflight;
}

function skipped(reason: DrainReason): DrainResult {
  return { reason, ran: false, sent: 0, failed: 0, deferred: 0 };
}

async function runDrain(reason: DrainReason): Promise<DrainResult> {
  const store = useOffline.getState();

  // Nothing can be sent without a bearer. The drainer re-triggers on signedIn.
  if (useSession.getState().status !== "signedIn") return skipped(reason);
  if (!store.online) return skipped(reason);
  if (store.paused === "auth") {
    // An explicit resume (session flip, /me no longer stating a wall, user
    // tap, retry) lifts the pause at once; any other trigger lifts it once
    // PAUSE_TTL_MS has passed, so a wall cleared server-side is noticed
    // without a tap. A wall still up just re-pauses (attempts untouched).
    const explicit = reason === "session" || reason === "manual" || reason === "retry";
    const expired = store.pausedAt != null && Date.now() - store.pausedAt >= PAUSE_TTL_MS;
    if (!explicit && !expired) return skipped(reason);
    unpause();
  }
  const who = owner();
  if (!who) return skipped(reason);
  const scope = eq(outbox.tenantId, who.tenantId);

  const db = getDb();
  const result: DrainResult = { reason, ran: true, sent: 0, failed: 0, deferred: 0 };
  store.set({ draining: true });

  try {
    reclaimExpiredLeases();
    gcDone();

    let lastSendAt = 0;
    for (;;) {
      const now = Date.now();
      const row = db
        .select()
        .from(outbox)
        .where(and(eq(outbox.status, "queued"), lte(outbox.nextAttemptAt, now), scope))
        .orderBy(asc(outbox.createdAt))
        .limit(1)
        .get();
      if (!row) break;

      // Claim. Sync SQLite + single-flight means this cannot race, but the
      // WHERE keeps it honest if a second engine instance ever appears.
      const claimed = db
        .update(outbox)
        .set({ status: "sending", leaseExpiresAt: now + LEASE_MS, updatedAt: now })
        .where(and(eq(outbox.id, row.id), eq(outbox.status, "queued")))
        .run();
      if (claimed.changes === 0) continue;
      publish();

      const handler = handlers.get(row.kind);
      if (!handler) {
        deferRow(row.id, row.attempts, NO_HANDLER_DEFER_MS, "NO_HANDLER", null);
        result.deferred += 1;
        continue;
      }

      // Pace so a post-outage flush never trips the tenant limiter.
      const wait = lastSendAt + PACE_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastSendAt = Date.now();

      let payload: unknown = null;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        // Unparseable payload is a bug, not a network problem: park it for a human.
        markFailed(row.id, row.attempts + 1, "BAD_PAYLOAD", null, false);
        result.failed += 1;
        continue;
      }

      try {
        const response = await handler(payload, row.idempotencyKey, {
          id: row.id,
          kind: row.kind,
          attempts: row.attempts,
          tenantId: who.tenantId,
          userId: row.userId,
          branchId: row.branchId,
        });
        // Mark done BEFORE anything else can happen (§6.6: never charged twice).
        markDone(row.id, response);
        result.sent += 1;
        touchLastSynced();
      } catch (err) {
        const attempts = row.attempts + 1;
        const outcome = classifyOutcome(err, attempts);
        // Only the server's own text (user-facing, Arabic) is kept for the
        // queue screen. An engine / JS failure is a machine code the sync
        // screen translates (mobile.offline.error.<code>) — never an
        // English literal in an Arabic-default UI.
        const message = isErrorLike(err) ? err.message : null;
        const code = isErrorLike(err) ? (err.code ?? err.kind) : "EXCEPTION";
        switch (outcome.kind) {
          case "done":
            markDone(row.id, null);
            result.sent += 1;
            touchLastSynced();
            break;
          case "retryable-network":
            deferRow(row.id, attempts, outcome.delayMs, code, message);
            result.deferred += 1;
            store.set({ lastError: message ?? code });
            // The network went away under us. Every later row would fail the
            // same way, so stop burning their attempts; the reconnect /
            // foreground / interval triggers restart the pass.
            return result;
          case "retryable-server":
            if (outcome.rateLimited) {
              // 429 is a verdict on the whole flush, not this row: push
              // every queued row past Retry-After (attempts untouched —
              // nobody got a fair try) and stop, instead of firing N doomed
              // requests that each burn an attempt (§6.3).
              deferAll(scope, outcome.delayMs, code, message);
              result.deferred += 1;
              store.set({ lastError: message ?? code });
              return result;
            }
            if (attempts >= MAX_ATTEMPTS) {
              // Reached the server MAX_ATTEMPTS times and never went through:
              // park it where a human can retry / edit / discard, instead of
              // an "N pending" that never moves (§6.3).
              markFailed(row.id, attempts, "MAX_ATTEMPTS", message, false);
              result.failed += 1;
              store.set({ lastError: message ?? code });
              break;
            }
            deferRow(row.id, attempts, outcome.delayMs, code, message);
            result.deferred += 1;
            store.set({ lastError: message ?? code });
            break;
          case "auth-wait":
            // Hand the row back untouched (attempts not counted — it never got a fair try).
            db.update(outbox)
              .set({ status: "queued", leaseExpiresAt: null, nextAttemptAt: 0, updatedAt: Date.now(), lastError: message ?? code, lastErrorCode: code })
              .where(eq(outbox.id, row.id))
              .run();
            store.set({ paused: "auth", pausedAt: Date.now(), pausedCode: code, lastError: message ?? code });
            publish();
            return result;
          case "terminal-failure":
            markFailed(row.id, attempts, outcome.code ?? code, outcome.message || message, outcome.actionable);
            result.failed += 1;
            store.set({ lastError: outcome.message || message });
            break;
        }
      }
    }

    // An empty pass is still a "we are in sync" signal for the chip.
    const c = counts();
    if (c.queued === 0 && result.deferred === 0) touchLastSynced();
    return result;
  } finally {
    useOffline.getState().set({ draining: false });
    publish();
  }
}

// ─── row transitions (all sync) ──────────────────────────────────────────────

function markDone(id: string, response: unknown) {
  const now = Date.now();
  getDb()
    .update(outbox)
    .set({
      status: "done",
      leaseExpiresAt: null,
      response: response === undefined ? null : JSON.stringify(response ?? null),
      lastError: null,
      lastErrorCode: null,
      lastErrorText: null,
      updatedAt: now,
    })
    .where(eq(outbox.id, id))
    .run();
  publish();
}

/** `text` is the server's own message or null — engine failures carry only `code`. */
function deferRow(id: string, attempts: number, delayMs: number, code: string, text: string | null) {
  const now = Date.now();
  getDb()
    .update(outbox)
    .set({
      status: "queued",
      attempts,
      nextAttemptAt: now + delayMs,
      leaseExpiresAt: null,
      lastError: text ?? code,
      lastErrorCode: code,
      lastErrorText: text,
      updatedAt: now,
    })
    .where(eq(outbox.id, id))
    .run();
  publish();
}

/**
 * 429: push EVERY queued row of the tenant (the one mid-send included) past
 * Retry-After without counting an attempt on any of them.
 */
function deferAll(scope: SQL, delayMs: number, code: string, text: string | null) {
  const now = Date.now();
  getDb()
    .update(outbox)
    .set({
      status: "queued",
      nextAttemptAt: now + delayMs,
      leaseExpiresAt: null,
      lastError: text ?? code,
      lastErrorCode: code,
      lastErrorText: text,
      updatedAt: now,
    })
    .where(and(sql`${outbox.status} IN ('queued', 'sending')`, scope))
    .run();
  publish();
}

function markFailed(id: string, attempts: number, code: string, text: string | null, actionable: boolean) {
  const now = Date.now();
  getDb()
    .update(outbox)
    .set({
      status: "failed",
      attempts,
      leaseExpiresAt: null,
      lastError: text ?? code,
      lastErrorCode: code,
      lastErrorText: text,
      actionable: actionable ? 1 : 0,
      updatedAt: now,
    })
    .where(eq(outbox.id, id))
    .run();
  publish();
}

function reclaimExpiredLeases() {
  const now = Date.now();
  getDb()
    .update(outbox)
    .set({ status: "queued", leaseExpiresAt: null, updatedAt: now })
    .where(and(eq(outbox.status, "sending"), lt(outbox.leaseExpiresAt, now)))
    .run();
}

/** Sweep `done` rows older than the TTL. Never touches queued/sending/failed. */
function gcDone() {
  const cutoff = Date.now() - DONE_TTL_MS;
  getDb()
    .delete(outbox)
    .where(and(eq(outbox.status, "done"), lt(outbox.updatedAt, cutoff)))
    .run();
}

/** Record "we talked to the server successfully just now" — disk + store. */
export function touchLastSynced(at: number = Date.now()) {
  init();
  writeMeta("lastSyncedAt", String(at));
  useOffline.getState().set({ lastSyncedAt: at, lastError: null });
}

// ─── plumbing ────────────────────────────────────────────────────────────────

/** Push counts + a revision bump to the store so subscribed UI re-reads. */
function publish() {
  const c = counts();
  const s = useOffline.getState();
  s.set({ queued: c.queued, failed: c.failed, revision: s.revision + 1 });
}

function toItem(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    kind: row.kind,
    payload: safeParse(row.payload),
    idempotencyKey: row.idempotencyKey,
    tenantId: row.tenantId,
    userId: row.userId,
    branchId: row.branchId,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    lastErrorCode: row.lastErrorCode,
    lastErrorText: row.lastErrorText,
    actionable: row.actionable === 1,
    response: row.response ? safeParse(row.response) : null,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
