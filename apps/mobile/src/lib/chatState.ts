/**
 * Mobile chat state helpers — ID generation + ID-based append dedup.
 *
 * Why this exists: mutation retries, double-taps, and stale `onSuccess` fires
 * can all produce duplicate assistant/user messages. React-Query's default
 * `retry: 3` means one successful chat response can fire `onSuccess` more
 * than once if a transient error precedes the final success. The old
 * `${Date.now()}_${rand6}` id generator also collides under fast successive
 * calls (two messages queued in the same ms would collide 1 in ~16M), which
 * breaks the client's ability to even DETECT a duplicate.
 *
 * Fix: a RFC-4122 v4 UUID per message + an `appendUnique` helper that silently
 * drops any append whose `id` is already present. First write wins.
 *
 * Pure. Tested in isolation (see chatState.test.ts).
 */

export interface HasId {
  id: string;
}

/** Return `prev` unchanged if a message with the same id already exists,
 *  otherwise return `[...prev, msg]`. Call this for EVERY assistant/user
 *  append — never `setMessages(p => [...p, msg])` directly.
 *
 *  First occurrence wins. Later duplicates are dropped silently; this is
 *  the right behaviour for retry races and double-tap defence.
 */
export function appendUnique<T extends HasId>(prev: T[], msg: T): T[] {
  if (prev.some((m) => m.id === msg.id)) return prev;
  return [...prev, msg];
}

/** Idempotent variant of a batch append. Keeps the first occurrence of each
 *  id — useful when a server response returns an array we want to concat
 *  without accidentally doubling an in-flight optimistic entry. */
export function appendManyUnique<T extends HasId>(prev: T[], next: T[]): T[] {
  if (next.length === 0) return prev;
  const seen = new Set(prev.map((m) => m.id));
  const out = prev.slice();
  for (const m of next) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** RFC 4122 v4 uuid using Math.random. Collision-safe enough for a client-
 *  side message key (the id is never used for auth or persistence). */
export function makeMessageId(): string {
  const hex = "0123456789abcdef";
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const s = bytes.map((b) => hex[(b >> 4) & 0xf]! + hex[b & 0xf]!).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
