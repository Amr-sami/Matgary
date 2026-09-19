import { createHash } from "node:crypto";
import { cacheGet, cacheSet, globalKey } from "@/lib/cache";

// Server-side idempotency for retried POSTs from the offline outbox.
//
// Contract:
//   - Client generates a UUID v4 in the browser, stores it on the outbox
//     row, and sends it as the `Idempotency-Key` header on every retry of
//     the same logical write.
//   - Server caches the response keyed by (tenant, key). A second POST
//     with the same key returns the cached body without re-running the
//     handler. So even if the outbox flushes the same row twice, the
//     server records the sale exactly once.
//   - The cached entry also carries a FINGERPRINT of (userId, body). A
//     replay whose fingerprint differs is not a retry — it is a different
//     write reusing a key (a client bug, or someone probing) — and gets
//     409 IDEMPOTENCY_MISMATCH instead of the other write's response.
//
// Two stores (doc 14 §10 M3):
//   Redis   fast path, 24h TTL. Long enough for any realistic retry window
//           (a cashier could reasonably be offline overnight), short enough
//           that keys don't accumulate forever.
//   Postgres durable path. POST /api/sales/cart also writes the key onto the
//           cart's anchor sales row under a partial UNIQUE index
//           (migration 0054), so a Redis flush / failover / expired TTL can
//           no longer let a retry book the cart twice. The unique violation
//           (23505) is mapped back to the existing cart by the route.
//
// Scoping: keys are namespaced by tenant + key so a leaked key from one
// tenant can't hijack another's response.

const TTL_SEC = 24 * 60 * 60; // 24h

export interface CachedResponse {
  status: number;
  body: unknown;
  /** Wall-clock when the original was processed. Useful for diagnostics. */
  at: number;
  /** sha256 over (userId, canonical body) — see `requestFingerprint`.
   *  Absent on entries written before the fingerprint existed; those replay
   *  unconditionally until their TTL runs out. */
  fingerprint?: string;
}

/** The Redis key for one (tenant, Idempotency-Key) pair. The fingerprint
 *  deliberately lives in the VALUE, not the key: a different body under the
 *  same key must find the original entry so it can be refused, not miss the
 *  cache and re-run the handler. */
export function idempotencyCacheKey(tenantId: string, idempotencyKey: string): string {
  return globalKey("idemp", tenantId, idempotencyKey);
}

/** Recursively sort object keys so two serialisations of the same JSON value
 *  hash the same regardless of property order. Arrays keep their order — a
 *  cart with its lines swapped IS a different cart. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256(userId + "\n" + sha256(canonical body)), hex. Binds a cached
 *  response to who sent it and exactly what they sent. */
export function requestFingerprint(userId: string, body: unknown): string {
  const bodyHash = createHash("sha256").update(canonicalJson(body ?? null)).digest("hex");
  return createHash("sha256").update(`${userId}\n${bodyHash}`).digest("hex");
}

export type IdempotencyLookup =
  /** Never seen (or Redis is down — the durable path still guards). */
  | { kind: "miss" }
  /** Same key, same request: hand back the original response. */
  | { kind: "replay"; cached: CachedResponse }
  /** Same key, different sender or body. */
  | { kind: "mismatch"; cached: CachedResponse };

/** Pull a previously-cached response and check it against the fingerprint
 *  of the request now being replayed. */
export async function lookupIdempotent(
  tenantId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<IdempotencyLookup> {
  const cached = await cacheGet<CachedResponse>(idempotencyCacheKey(tenantId, idempotencyKey));
  return classifyLookup(cached, fingerprint);
}

/** Pure half of `lookupIdempotent`, so the decision is unit-testable. */
export function classifyLookup(
  cached: CachedResponse | null,
  fingerprint: string,
): IdempotencyLookup {
  if (!cached) return { kind: "miss" };
  if (cached.fingerprint && cached.fingerprint !== fingerprint) {
    return { kind: "mismatch", cached };
  }
  return { kind: "replay", cached };
}

/** Pull a previously-cached response. Returns null if no replay seen.
 *  Kept for callers that have no body to fingerprint (or predate it); new
 *  code should use `lookupIdempotent`. */
export async function getCachedResponse(
  tenantId: string,
  idempotencyKey: string,
): Promise<CachedResponse | null> {
  return cacheGet<CachedResponse>(idempotencyCacheKey(tenantId, idempotencyKey));
}

/** Store the response so subsequent replays of the same key are no-ops. */
export async function rememberResponse(
  tenantId: string,
  idempotencyKey: string,
  status: number,
  body: unknown,
  fingerprint?: string,
): Promise<void> {
  await cacheSet<CachedResponse>(
    idempotencyCacheKey(tenantId, idempotencyKey),
    { status, body, at: Date.now(), ...(fingerprint ? { fingerprint } : {}) },
    TTL_SEC,
  );
}

/** The 409 body every idempotency-mismatch answer carries. */
export const IDEMPOTENCY_MISMATCH_BODY = { error: "IDEMPOTENCY_MISMATCH" } as const;

/**
 * True when `err` is Postgres unique_violation (23505) on the given index /
 * constraint. postgres.js surfaces the code on the error itself; drizzle
 * may wrap it one level down in `cause`. `constraint` is optional — without
 * it any unique violation matches — but callers should name the index so an
 * unrelated duplicate is not mistaken for a replay.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as
    | { code?: string; constraint_name?: string; constraint?: string; cause?: unknown }
    | null
    | undefined;
  if (!e || typeof e !== "object") return false;
  const code = e.code ?? (e.cause as { code?: string } | undefined)?.code;
  if (code !== "23505") return false;
  if (!constraint) return true;
  const c = e.cause as { constraint_name?: string; constraint?: string } | undefined;
  const name = e.constraint_name ?? e.constraint ?? c?.constraint_name ?? c?.constraint;
  return name === constraint;
}

/** Name of the partial unique index from migration 0054. */
export const SALES_IDEMPOTENCY_INDEX = "sales_tenant_idempotency_key_idx";

export interface CartShape {
  userId: string | null;
  lines: { productId: string; quantity: number }[];
}

/**
 * Durable-path mismatch check. When the anchor INSERT hits the unique index
 * there may be no Redis entry (flushed, expired) to fingerprint against, so
 * the request is compared with what the key actually booked: same user and
 * the same multiset of (productId, quantity). Order-insensitive on purpose —
 * the rows come back in storage order, not cart order.
 */
export function sameCart(a: CartShape, b: CartShape): boolean {
  if ((a.userId ?? null) !== (b.userId ?? null)) return false;
  if (a.lines.length !== b.lines.length) return false;
  const key = (l: { productId: string; quantity: number }) => `${l.productId}|${l.quantity}`;
  const as = a.lines.map(key).sort();
  const bs = b.lines.map(key).sort();
  return as.every((k, i) => k === bs[i]);
}

/**
 * Validate the shape of an Idempotency-Key header. Refusing malformed
 * keys early stops a busted client from filling Redis with junk and
 * accidentally blocking real retries.
 *
 * Accepts: UUID v4 OR a 32-byte url-safe base64 (length ≤ 64). Anything
 * else returns null and the caller should ignore the header.
 */
export function validateIdempotencyKey(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v.length < 8 || v.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return null;
  return v;
}
