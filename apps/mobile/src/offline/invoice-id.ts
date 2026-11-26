/**
 * Device-scoped invoice ids (doc 06 §6.5 "Two devices, same invoice id").
 *
 * `sales.invoice_id` is a plain text column with a NON-unique index, so two
 * terminals that mint the same id both get stored. Until the server gets a
 * unique constraint (S3) the client keeps ids from colliding by construction:
 *
 *     INV-<device 4 base36><ts base36><rand 4 base36>
 *     INV-K7Q2 MDX4F9ZP 3H1A          (spaces for reading only)
 *
 *  - device: 4 base36 chars derived from expo-application's vendor / Android
 *    id the first time this module runs on a device, then persisted in MMKV
 *    so the suffix never changes for the life of the install (a reinstall on
 *    iOS gets a new IDFV → a new suffix, which is fine: an id only has to be
 *    unique, not stable across installs). Until the async IDFV lookup lands
 *    — or when it fails (simulator, restricted) — a random suffix is minted
 *    and persisted instead; whichever is persisted first wins for good.
 *  - ts: Date.now() in base36 (8 chars until the year 2059) — monotonic per
 *    device to the millisecond, and it sorts.
 *  - rand: 4 base36 chars (1.7M) against two rings in the same millisecond.
 *
 * Shape: 20 chars, `[A-Z0-9-]` only. That satisfies BOTH server regexes at
 * once — `options.invoiceId` (`^[A-Za-z0-9_\-:.]+$`, ≤80) and the
 * `Idempotency-Key` header (`^[A-Za-z0-9_-]{8,64}$`, apps/web/lib/api/
 * idempotency.ts) — because the invoice id IS the idempotency key. The
 * derived keys `sales.ts` mints for a re-submit (`<id>-r1`, `<id>-r2`, …)
 * stay in shape and far under 64.
 */
import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { createMMKV } from "react-native-mmkv";

const storage = createMMKV({ id: "device" });
const DEVICE_KEY = "invoice-device-suffix";
const SUFFIX_LEN = 4;
const RAND_LEN = 4;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Longest id `mintInvoiceId()` produces; the server accepts ≤ 64 as a key. */
export const INVOICE_ID_MAX_LEN = 4 + SUFFIX_LEN + 9 + RAND_LEN;

function randomBase36(len: number): string {
  const bytes = Crypto.getRandomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 36];
  return out;
}

/** FNV-1a over a string → `len` base36 chars. Deterministic: the same install id → the same suffix. */
export function suffixFromInstallId(installId: string, len = SUFFIX_LEN): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < installId.length; i++) {
    h ^= installId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).toUpperCase().padStart(len, "0").slice(-len);
}

let cached: string | null = null;

/**
 * The persisted 4-char device suffix. Synchronous: a first-ever call before
 * the IDFV lookup resolves persists a random suffix, and the lookup then
 * finds the slot taken and leaves it. Never changes once written.
 */
export function deviceSuffix(): string {
  if (cached) return cached;
  const stored = storage.getString(DEVICE_KEY);
  if (stored && stored.length === SUFFIX_LEN) {
    cached = stored;
    return stored;
  }
  const fresh = randomBase36(SUFFIX_LEN);
  storage.set(DEVICE_KEY, fresh);
  cached = fresh;
  return fresh;
}

/** Best effort: seed the suffix from the platform install id if nothing is persisted yet. */
async function primeDeviceSuffix(): Promise<void> {
  if (storage.getString(DEVICE_KEY)) return;
  try {
    const installId =
      Platform.OS === "android"
        ? Application.getAndroidId()
        : Platform.OS === "ios"
          ? await Application.getIosIdForVendorAsync()
          : null;
    if (!installId) return;
    // Re-check: a mint may have raced the lookup and persisted a random one.
    if (storage.getString(DEVICE_KEY)) return;
    const suffix = suffixFromInstallId(installId);
    storage.set(DEVICE_KEY, suffix);
    cached = suffix;
  } catch {
    // Simulator / restricted: the random fallback in deviceSuffix() stands.
  }
}
void primeDeviceSuffix();

/** A new, device-scoped invoice id — also the Idempotency-Key of that sale. */
export function mintInvoiceId(now: number = Date.now()): string {
  return `INV-${deviceSuffix()}${now.toString(36).toUpperCase()}${randomBase36(RAND_LEN)}`;
}

/**
 * The key for re-submitting a refused sale under NEW options (§6.5 "sell
 * anyway"). The cart route caches every 4xx domain refusal under the original
 * Idempotency-Key for 24h, so replaying `<id>` — whatever the body now says —
 * returns the cached INSUFFICIENT_STOCK. A derived key is evaluated afresh,
 * and the server never booked the original, so it cannot double-post.
 * `INV-…-r1`, then `-r2` if that one is refused too.
 */
export function derivedRetryKey(invoiceId: string, previous: string | null = null): string {
  const base = invoiceId.replace(/-r\d+$/, "");
  const m = /-r(\d+)$/.exec(previous ?? invoiceId);
  const n = m ? Number(m[1]) + 1 : 1;
  return `${base}-r${n}`;
}
