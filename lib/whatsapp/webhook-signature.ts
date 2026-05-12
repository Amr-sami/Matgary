// X-Hub-Signature-256 verification for Meta webhooks.
//
// Meta signs every webhook body with HMAC-SHA256 keyed by the App Secret.
// We MUST verify against the *raw* request body (byte-for-byte what Meta
// sent), so the route handler reads `req.text()` before any JSON parsing
// and passes the same string here.
//
// Comparison is timing-safe via crypto.timingSafeEqual.

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-hub-signature-256";
const PREFIX = "sha256=";

export type SignatureFailure =
  | "missing_secret"
  | "missing_header"
  | "malformed_header"
  | "length_mismatch"
  | "digest_mismatch";

export interface VerifyResult {
  ok: boolean;
  reason?: SignatureFailure;
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string | null | undefined,
): VerifyResult {
  if (!appSecret) return { ok: false, reason: "missing_secret" };
  if (!signatureHeader) return { ok: false, reason: "missing_header" };
  if (!signatureHeader.startsWith(PREFIX)) {
    return { ok: false, reason: "malformed_header" };
  }

  const providedHex = signatureHeader.slice(PREFIX.length);
  // 32-byte SHA256 -> 64 hex chars. Reject anything else before decoding,
  // so we don't crash on garbage input.
  if (providedHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(providedHex)) {
    return { ok: false, reason: "malformed_header" };
  }

  let provided: Buffer;
  let expected: Buffer;
  try {
    provided = Buffer.from(providedHex, "hex");
    expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  } catch {
    return { ok: false, reason: "malformed_header" };
  }

  if (provided.length !== expected.length) {
    return { ok: false, reason: "length_mismatch" };
  }
  return timingSafeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: "digest_mismatch" };
}
