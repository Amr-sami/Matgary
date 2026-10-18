// Digital collections L2 — forwarded-message text at rest (spec 07 §4.10;
// 03 §B.2.6, §E.3, §E.4).
//
//   encryptRawText / decryptRawText  AES-256-GCM, the `encryptSecret` on-disk
//                                    format (`v1:<iv>:<ct>:<tag>`), keyed with
//                                    the `collections.raw` purpose key — so a
//                                    raw row never decrypts with the base
//                                    SECRET_KEY key (WhatsApp credentials).
//   encodeTitleSubtitle / decode     `title_enc` holds [title, subtitle] as JSON
//                                    (the table has no subtitle column).
//   bodySha256                       SHA-256 hex of the NFC-normalised body.
//   payerPhoneHmac                   HMAC-SHA256 (`collections.phone`) of 06's
//                                    normalised 01XXXXXXXXX form; equality only.
//   rawExpiresAt                     the §4.10 retention table.
//
// Payer-name masking and last-4 are 06's (`maskPayerName`, `phoneLast4`), not
// redefined here (spec 07 acceptance 26).

import { createHash } from "node:crypto";
import { decryptSecret, deriveKey, encryptSecret, hmacSha256Hex } from "@/lib/crypto";
import { normalizeEgyptMobile } from "@matgary/domain/collections/normalize";
import type { ParseStatus } from "@matgary/domain/collections/types";

const DAY_MS = 86_400_000;

/** Encrypt one text with the `collections.raw` purpose key. */
export function encryptRawText(plain: string): string {
  return encryptSecret(plain, deriveKey("collections.raw"));
}

/** Decrypt a stored value; null / empty stays null. Throws on a value that
 *  was encrypted with another key (GCM authentication fails). */
export function decryptRawText(stored: string | null | undefined): string | null {
  if (stored == null || stored === "") return null;
  return decryptSecret(stored, deriveKey("collections.raw"));
}

/** `[title, subtitle]` as JSON, or null when both are absent / empty. */
export function encodeTitleSubtitle(title: string | null | undefined, subtitle: string | null | undefined): string | null {
  const t = title ? title : null;
  const s = subtitle ? subtitle : null;
  if (t === null && s === null) return null;
  return JSON.stringify([t, s]);
}

/** Inverse of `encodeTitleSubtitle` (a legacy plain string reads as the title). */
export function decodeTitleSubtitle(plain: string | null): { title: string | null; subtitle: string | null } {
  if (plain == null) return { title: null, subtitle: null };
  try {
    const v = JSON.parse(plain) as unknown;
    if (Array.isArray(v)) {
      return {
        title: typeof v[0] === "string" ? v[0] : null,
        subtitle: typeof v[1] === "string" ? v[1] : null,
      };
    }
  } catch {
    /* fall through */
  }
  return { title: plain, subtitle: null };
}

/** SHA-256 hex of the NFC-normalised body (`collection_raw_messages.body_sha256`). */
export function bodySha256(body: string): string {
  return createHash("sha256").update(body.normalize("NFC"), "utf8").digest("hex");
}

/** HMAC of the payer phone in 06's national form; null when it is not an
 *  Egyptian mobile (never stored, never displayed). */
export function payerPhoneHmac(phone: string | null | undefined): string | null {
  const m = normalizeEgyptMobile(phone);
  if (!m) return null;
  return hmacSha256Hex("collections.phone", m.national);
}

export interface RawExpiryOptions {
  test?: boolean;
  /** `shared_at` of the row (owner tapped "send to TheStoro"). */
  sharedAt?: Date | string | null;
  now?: Date;
}

/**
 * The §4.10 retention table — shared wins, then test, then status:
 * shared → shared_at + 90 d · test → now + 1 d · parsed → 7 d ·
 * fallback / unknown_format → 30 d · not_credit / too_old / duplicate / otp → 2 d.
 */
export function rawExpiresAt(status: ParseStatus, opts: RawExpiryOptions = {}): Date {
  const now = opts.now ?? new Date();
  if (opts.sharedAt) {
    const at = opts.sharedAt instanceof Date ? opts.sharedAt : new Date(opts.sharedAt);
    return new Date(at.getTime() + 90 * DAY_MS);
  }
  if (opts.test) return new Date(now.getTime() + DAY_MS);
  switch (status) {
    case "parsed":
      return new Date(now.getTime() + 7 * DAY_MS);
    case "fallback":
    case "unknown_format":
      return new Date(now.getTime() + 30 * DAY_MS);
    default:
      return new Date(now.getTime() + 2 * DAY_MS);
  }
}
