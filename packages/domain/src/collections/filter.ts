// Digital collections — the device-side pre-filter (spec 06 §4.9, part B).
//
// Phones forward only messages that look like money received (or a wallet
// debit, D06-a) and are not one-time passwords. The SAME constants are served
// to phones by spec 07's GET /api/v1/collections/ingest/config, so a keyword
// or OTP fix reaches every phone without an app release (Q13). Bump
// FILTER_CONFIG_VERSION on every edit of either list.
//
// - CANDIDATE_KEYWORDS match as case-insensitive substrings. Devices match
//   them against the RAW text (spec 11 in Kotlin, spec 10 in Shortcuts'
//   "contains"), so every Arabic spelling is listed raw; the server matches
//   the normalised text against the normalised keywords.
// - OTP_PATTERNS must be portable across JS, Java `Pattern` and ICU
//   (Shortcuts "Match Text"): no lookbehind, no named groups, no Unicode
//   property escapes, no word boundaries, no inline flags. Every client
//   applies them case-insensitively. Both the taa-marbuta and the haa
//   spelling appear, so raw and normalised texts both match.
//
// Hermes-safe (mobile may import this file): see __tests__/hermes-safe.test.ts.

import { normalizeDigits, normalizeText } from "./normalize";

/** "<ISO date of the last change>-<n>"; bump on every edit of the two lists. */
export const FILTER_CONFIG_VERSION = "2026-10-18-1";

export const CANDIDATE_KEYWORDS = {
  ar: ["استلام", "إستلام", "استقبال", "إستقبال", "إضافة", "اضافة", "إيداع", "ايداع", "تحويل لحظي", "تم تحويل"],
  en: ["received", "credited", "IPN", "cash-in"],
} as const;

export const OTP_PATTERNS: readonly string[] = [
  "(^|[^a-z])otp([^a-z]|$)",
  "one[ -]?time (pass|code|pin)",
  "verification code",
  "passcode",
  "do not share",
  "don'?t share",
  "[كق]ود (ال)?(تحقق|تفعيل|سري)",
  "رمز (ال)?(تحقق|تفعيل|سري|المرور)",
  "كلم[ةه] (ال)?(مرور|سر)",
  "الرقم السري",
  "لا تشارك",
  "لا تفصح",
  "لمر[ةه] واحد[ةه]",
];

const OTP_RES: readonly RegExp[] = OTP_PATTERNS.map((p) => new RegExp(p, "i"));

// Zero-width and bidi controls (U+200B–200F, U+202A–202E, U+2066–2069), the
// Arabic letter mark U+061C, the BOM U+FEFF and tatweel U+0640
// (normalizeText-lite; a stretched "رمـز التحقق" is still an OTP).
const INVISIBLES_RE = /[​-‏‪-‮⁦-⁩؜﻿ـ]/g;

/** Digits to ASCII, invisible marks dropped, white space collapsed. */
function liteNormalize(text: string): string {
  return normalizeDigits(String(text)).replace(INVISIBLES_RE, "").replace(/\s+/g, " ").trim();
}

/** True when the text looks like a one-time password / security code. */
export function isOtp(text: string): boolean {
  const s = liteNormalize(text);
  for (const re of OTP_RES) if (re.test(s)) return true;
  return false;
}

const NORMALISED_KEYWORDS: readonly string[] = [...CANDIDATE_KEYWORDS.ar, ...CANDIDATE_KEYWORDS.en].map((k) =>
  normalizeText(k).toLowerCase(),
);

function joinParts(i: { title?: string | null; subtitle?: string | null; body: string }): string {
  const parts: string[] = [];
  for (const p of [i.title, i.subtitle, i.body]) if (p != null && String(p) !== "") parts.push(String(p));
  return parts.join("\n");
}

/**
 * A message is a candidate (forwarded to the server) when it carries a
 * candidate keyword AND is not an OTP. Title, subtitle and body are joined
 * with "\n" exactly as parse.ts `messageText` does.
 */
export function isCandidateMessage(input: { title?: string | null; subtitle?: string | null; body: string }): boolean {
  const raw = joinParts(input);
  if (isOtp(raw)) return false;
  const s = normalizeText(raw).toLowerCase();
  for (const k of NORMALISED_KEYWORDS) if (s.indexOf(k) !== -1) return true;
  return false;
}
