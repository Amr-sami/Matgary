/**
 * This phone's link record (doc 15 spec 09 §4.6.4 rule 4, §4.6.6): MMKV id
 * `collections-setup`, one JSON value under the key `link` (pattern
 * `src/offline/invoice-id.ts`).
 *
 * NON-SECRETS ONLY: `{deviceId, platform, variant, tokenDelivered,
 * baselineSeenAt, baselineMessageAt, createdAt, completedAt,
 * replacesDeviceId, accountLabels}`. The ingest token is never written here
 * (09 §6.11; it lives in a `useRef` inside `automation.tsx`, then inside the
 * shortcut, the Keychain (M3) or EncryptedSharedPreferences (M4)).
 *
 * Survives sign-out and a user switch on purpose (US-M4-04): it is cleared
 * only by a revoke or an absent-on-200 reconcile.
 */
import { createMMKV } from "react-native-mmkv";

import { EMPTY_RECORD, type SetupRecord } from "./wizard";

const storage = createMMKV({ id: "collections-setup" });
const KEY = "link";

/** Keys a record may carry; anything else (an older shape, a stray secret) is dropped on read and write. */
const FIELDS = Object.keys(EMPTY_RECORD) as (keyof SetupRecord)[];

function sanitize(raw: unknown): SetupRecord {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...EMPTY_RECORD };
  for (const k of FIELDS) if (k in src) out[k] = src[k];
  out.tokenDelivered = out.tokenDelivered === true;
  out.accountLabels = Array.isArray(out.accountLabels) ? (out.accountLabels as unknown[]).filter((x) => typeof x === "string") : [];
  return out as unknown as SetupRecord;
}

/** The record, or null when this phone has none. */
export function read(): SetupRecord | null {
  try {
    const s = storage.getString(KEY);
    if (!s) return null;
    return sanitize(JSON.parse(s));
  } catch {
    return null;
  }
}

/** Merge a patch into the record (creates it). */
export function write(patch: Partial<SetupRecord>): SetupRecord {
  const next = sanitize({ ...(read() ?? EMPTY_RECORD), ...patch });
  storage.set(KEY, JSON.stringify(next));
  return next;
}

export function clear(): void {
  storage.remove(KEY);
}
