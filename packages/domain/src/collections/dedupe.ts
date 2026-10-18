// Digital collections — dedupe keys and device fingerprints (spec 06 §4.12,
// part B; 03 §C.9).
//
// - creditDedupeKey: the `collection_credits.dedupe_key` (unique per tenant)
//   that makes the same credit, re-posted or seen again, one row.
// - shouldMergeCrossChannel: the same credit arriving by SMS AND by
//   notification (different channels, a few minutes apart) merges into one.
// - clientFingerprint: the per-device `fp` of a raw message. Specs 10 (iOS
//   Shortcuts / Swift) and 11 (Kotlin) reproduce the pre-images and the shared
//   test vectors in __tests__/dedupe.test.ts byte for byte.
// - sha256Hex: pure JS (Hermes has no node:crypto), FIPS 180-4 over UTF-8.

import { MATCH_CONSTANTS } from "./match";
import { toPiasters } from "./normalize";
import type { CollectionProvider, IngestChannel } from "./types";

function ms(v: Date | string): number {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

// ---------------------------------------------------------------------------
// Credit keys
// ---------------------------------------------------------------------------

/**
 *  reference → "r:<provider|unknown>:<accountId ?? receivingHint ?? '-'>:<reference>"
 *  balance   → "b:<accountId ?? provider ?? 'unknown'>:<amountPt>:<balancePt>"
 *  otherwise → "f:<accountId ?? provider ?? 'unknown'>:<amountPt>:<payerPhoneLast4 ?? '-'>:<floor(epochMs / 600000)>"
 *              + "#n" when collisionIndex = n > 0 (a same-channel message with a different body hash collided)
 */
export function creditDedupeKey(c: {
  provider: CollectionProvider | null;
  accountId: string | null;
  receivingHint: string | null;
  operatorReference: string | null;
  amount: string;
  balanceAfter: string | null;
  payerPhoneLast4: string | null;
  occurredAt: Date | string;
  collisionIndex?: number;
}): string {
  const amountPt = toPiasters(c.amount);
  if (c.operatorReference != null && c.operatorReference !== "") {
    return `r:${c.provider ?? "unknown"}:${c.accountId ?? c.receivingHint ?? "-"}:${c.operatorReference.toLowerCase()}`;
  }
  const owner = c.accountId ?? c.provider ?? "unknown";
  if (c.balanceAfter != null && c.balanceAfter !== "") {
    return `b:${owner}:${amountPt}:${toPiasters(c.balanceAfter)}`;
  }
  const bucket = Math.floor(ms(c.occurredAt) / 600_000);
  const suffix = c.collisionIndex ? `#${c.collisionIndex}` : "";
  return `f:${owner}:${amountPt}:${c.payerPhoneLast4 ?? "-"}:${bucket}${suffix}`;
}

function conflicts(a: string | null, b: string | null): boolean {
  return a != null && b != null && a !== "" && b !== "" && a.toLowerCase() !== b.toLowerCase();
}

/**
 * Merge when: same accountId (both non-null) · same amount in piasters ·
 * |Δoccurred| ≤ MERGE_WINDOW_MIN · the incoming channel is not already on the
 * credit · no conflict on reference / balance / payer last 4 (a conflict =
 * both present and different).
 */
export function shouldMergeCrossChannel(
  existing: {
    accountId: string | null;
    amount: string;
    occurredAt: Date | string;
    channels: readonly IngestChannel[];
    operatorReference: string | null;
    balanceAfter: string | null;
    payerPhoneLast4: string | null;
  },
  incoming: {
    accountId: string | null;
    amount: string;
    occurredAt: Date | string;
    channel: IngestChannel;
    operatorReference: string | null;
    balanceAfter: string | null;
    payerPhoneLast4: string | null;
  },
): boolean {
  if (existing.accountId == null || incoming.accountId == null || existing.accountId !== incoming.accountId) return false;
  if (toPiasters(existing.amount) !== toPiasters(incoming.amount)) return false;
  const delta = Math.abs(ms(existing.occurredAt) - ms(incoming.occurredAt));
  if (!(delta <= MATCH_CONSTANTS.MERGE_WINDOW_MIN * 60_000)) return false;
  if (existing.channels.indexOf(incoming.channel) !== -1) return false;
  if (conflicts(existing.operatorReference, incoming.operatorReference)) return false;
  if (
    existing.balanceAfter != null &&
    incoming.balanceAfter != null &&
    toPiasters(existing.balanceAfter) !== toPiasters(incoming.balanceAfter)
  ) {
    return false;
  }
  if (conflicts(existing.payerPhoneLast4, incoming.payerPhoneLast4)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Device fingerprints (03 §C.9)
// ---------------------------------------------------------------------------

export type FingerprintInput =
  | { kind: "android_notification"; packageName: string; title: string | null; text: string | null } // spec 11
  | { kind: "ios"; channel: "ios_sms" | "ios_notification"; sender: string | null; body: string; receivedAtMinute: string } // spec 10
  | { kind: "android_sms"; address: string; body: string; timestampMs: number } // spec 11 appendix (M5)
  | { kind: "manual_paste"; sender: string | null; body: string }; // spec 07

/**
 * Trim and collapse runs of ASCII white space [ \t\n\r\f\v] to one space
 * (ASCII only, so Kotlin `Regex("[ \\t\\n\\r\\f\\u000B]+")` reproduces it).
 * null → "".
 */
function fpNorm(s: string | null): string {
  if (s == null) return "";
  return s.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ /, "").replace(/ $/, "");
}

/** The pre-image of a device fingerprint (exported for specs 10 / 11's vector tests). */
export function fingerprintPreimage(i: FingerprintInput): string {
  switch (i.kind) {
    case "android_notification":
      return `${i.packageName}|${fpNorm(i.title)}|${fpNorm(i.text)}`;
    case "ios":
      return `${i.channel}|${i.sender ?? ""}|${i.body}|${i.receivedAtMinute}`;
    case "android_sms":
      return `${i.address}|${i.body}|${i.timestampMs}`;
    case "manual_paste":
      return `manual_paste|${i.sender ?? ""}|${fpNorm(i.body)}`;
  }
}

/** Lower-case hex sha256 of the UTF-8 pre-image (64 chars; fits §B.2.6). */
export function clientFingerprint(i: FingerprintInput): string {
  return sha256Hex(fingerprintPreimage(i));
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), pure JS
// ---------------------------------------------------------------------------

/** UTF-8 bytes of a JS string; lone surrogates become U+FFFD (as TextEncoder / Buffer do). */
function utf8(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (n - 0xdc00);
        i++;
      } else c = 0xfffd;
    } else if (c >= 0xdc00 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];

/** Lower-case hex SHA-256 of the string's UTF-8 bytes. */
export function sha256Hex(s: string): string {
  const bytes = utf8(s);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length (messages here are far below 2^32 bits; the high word is still computed)
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
  bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Array<number>(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      W[t] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15];
      const w2 = W[t - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  let hex = "";
  for (const v of H) hex += (v >>> 0).toString(16).padStart(8, "0");
  return hex;
}
