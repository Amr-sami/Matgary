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
//
// Storage: Redis with a 24h TTL. That's long enough for any realistic
// retry window (a cashier could reasonably be offline overnight) and
// short enough that idempotency keys don't accumulate forever.
//
// Scoping: keys are namespaced by tenant + key so a leaked key from one
// tenant can't hijack another's response.

const TTL_SEC = 24 * 60 * 60; // 24h

interface CachedResponse {
  status: number;
  body: unknown;
  /** Wall-clock when the original was processed. Useful for diagnostics. */
  at: number;
}

function key(tenantId: string, idempotencyKey: string): string {
  return globalKey("idemp", tenantId, idempotencyKey);
}

/** Pull a previously-cached response. Returns null if no replay seen. */
export async function getCachedResponse(
  tenantId: string,
  idempotencyKey: string,
): Promise<CachedResponse | null> {
  return cacheGet<CachedResponse>(key(tenantId, idempotencyKey));
}

/** Store the response so subsequent replays of the same key are no-ops. */
export async function rememberResponse(
  tenantId: string,
  idempotencyKey: string,
  status: number,
  body: unknown,
): Promise<void> {
  await cacheSet<CachedResponse>(
    key(tenantId, idempotencyKey),
    { status, body, at: Date.now() },
    TTL_SEC,
  );
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
