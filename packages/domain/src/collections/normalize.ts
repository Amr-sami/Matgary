// Digital collections — normalisation, money in piasters, phone / wallet /
// IBAN validators, and the masks shown in the UI and on receipts.
// Spec 06 §4.3 (part A: the M1 account form, the DTO mask and receipts need
// it, 06 ARCH CHANGE REQUEST 2). Pure, no IO.
//
// Hermes-safe: no lookbehind, no Unicode property escapes, no named groups,
// no dotAll flag, no time-zone APIs. The single String.prototype.normalize
// call below is guarded, because Hermes may lack it
// (__tests__/hermes-safe.test.ts checks the guard).

import type { IngestChannel, SenderKind } from "./types";

// ---------------------------------------------------------------------------
// Digits and text
// ---------------------------------------------------------------------------

/**
 * Arabic-Indic (U+0660–0669) and extended Arabic-Indic (U+06F0–06F9) digits
 * become ASCII; the Arabic decimal separator U+066B becomes "." and the
 * Arabic thousands separator U+066C becomes ",".
 */
export function normalizeDigits(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x0660 && c <= 0x0669) out += String.fromCharCode(48 + (c - 0x0660));
    else if (c >= 0x06f0 && c <= 0x06f9) out += String.fromCharCode(48 + (c - 0x06f0));
    else if (c === 0x066b) out += ".";
    else if (c === 0x066c) out += ",";
    else out += s[i];
  }
  return out;
}

// Zero-width and bidi controls (U+200B–200F, U+202A–202E, U+2066–2069), the
// Arabic letter mark U+061C, the BOM U+FEFF and tatweel U+0640.
const INVISIBLES_RE = /[​-‏‪-‮⁦-⁩؜﻿ـ]/g;
// Alef with hamza above / below / madda, alef wasla → bare alef.
const ALEF_RE = /[أإآٱ]/g;
// Horizontal white space (not the newline, which is kept).
const HSPACE_RE = /[\t\f\v    -   　]+/g;

/**
 * The parse-side normalisation of 03 §D.2, in this order:
 *  1. NFKC when String.prototype.normalize exists;
 *  2. strip zero-width / bidi marks and tatweel ("بـ" → "ب");
 *  3. normalizeDigits;
 *  4. fold أ إ آ ٱ → ا, ى → ي, ة → ه;
 *  5. CR/CRLF → LF; runs of horizontal space → one space; spaces around a
 *     newline dropped; repeated newlines → one; trim.
 * Newlines are KEPT (EM-2's payer name ends at one). Latin case is kept; the
 * templates use the `i` flag.
 */
export function normalizeText(raw: string): string {
  let s = typeof "".normalize === "function" ? String(raw).normalize("NFKC") : String(raw);
  s = s.replace(INVISIBLES_RE, "");
  s = normalizeDigits(s);
  s = s.replace(ALEF_RE, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(HSPACE_RE, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n+/g, "\n");
  return s.trim();
}

/**
 * Sender ids are compared case-insensitively (D06-b): trim, collapse white
 * space to one space, lower-case. `null` gives "".
 */
export function normalizeSender(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * How far a message's sender can be trusted (§B.1 `SenderKind`):
 * - notification channels → `app` (the OS binds the notification to a package);
 * - an empty sender → `numeric` (least trusted);
 * - only "+", digits, spaces and "-" (after normalizeDigits) → `numeric`;
 * - anything else → `alphanumeric`.
 */
export function senderKindOf(channel: IngestChannel, sender: string | null | undefined): SenderKind {
  if (channel === "ios_notification" || channel === "android_notification") return "app";
  const s = sender == null ? "" : normalizeDigits(String(sender)).trim();
  if (s === "") return "numeric";
  if (/^[+0-9\s-]+$/.test(s)) return "numeric";
  return "alphanumeric";
}

// ---------------------------------------------------------------------------
// Money: decimal strings in and out, integer piasters for every comparison
// ---------------------------------------------------------------------------

const AMOUNT_RE = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * "2,700.00" → 270000, "500.5" → 50050, "20000" → 2000000, "٢٠٠٠.٠٠" → 200000.
 * Accepts a string (commas stripped, Arabic-Indic digits allowed) or a
 * finite, non-negative number. Throws RangeError otherwise ("1.234", "-5",
 * "abc", NaN).
 */
export function toPiasters(amount: string | number): number {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`toPiasters: invalid amount ${amount}`);
    const direct = String(amount);
    if (AMOUNT_RE.test(direct)) return piastersFromDecimal(direct);
    // Binary floating-point noise (0.1 + 0.2): accept only when the value is
    // a whole number of piasters to within 1e-6.
    const scaled = amount * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) < 1e-6 && Number.isSafeInteger(rounded)) return rounded;
    throw new RangeError(`toPiasters: more than 2 decimals in ${amount}`);
  }
  if (typeof amount !== "string") throw new RangeError("toPiasters: amount must be a string or a number");
  const s = normalizeDigits(amount).trim().replace(/,/g, "");
  if (!AMOUNT_RE.test(s)) throw new RangeError(`toPiasters: invalid amount "${amount}"`);
  return piastersFromDecimal(s);
}

function piastersFromDecimal(s: string): number {
  const m = AMOUNT_RE.exec(s);
  if (!m) throw new RangeError(`toPiasters: invalid amount "${s}"`);
  const whole = parseInt(m[1], 10);
  const frac = m[2] === undefined ? 0 : parseInt(m[2].length === 1 ? m[2] + "0" : m[2], 10);
  const pt = whole * 100 + frac;
  if (!Number.isSafeInteger(pt)) throw new RangeError(`toPiasters: amount too large "${s}"`);
  return pt;
}

/** 270000 → "2700.00" (the `numeric(14,2)` wire form). Integers only. */
export function fromPiasters(pt: number): string {
  if (!Number.isSafeInteger(pt)) throw new RangeError(`fromPiasters: not an integer number of piasters: ${pt}`);
  const sign = pt < 0 ? "-" : "";
  const abs = Math.abs(pt);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${frac < 10 ? "0" : ""}${frac}`;
}

// ---------------------------------------------------------------------------
// Phones, wallets, IBAN
// ---------------------------------------------------------------------------

export interface EgyptMobile {
  /** 01XXXXXXXXX */
  national: string;
  /** +201XXXXXXXXX */
  e164: string;
}

/**
 * Egyptian mobile numbers, with the prefix rules of
 * apps/web/lib/validators/egypt.ts `normalizeEgyptPhone` (not moved; mirrored):
 * Arabic-Indic digits allowed; spaces, parentheses, "-", "_", "." dropped; a
 * leading "+", "0020", "0" and then "20" stripped; the rest must be 10 digits
 * starting with 1 whose second digit is in 0125.
 */
export function normalizeEgyptMobile(raw: string | null | undefined): EgyptMobile | null {
  if (raw == null) return null;
  const cleaned = normalizeDigits(String(raw)).replace(/[\s()\-_.]/g, "").trim();
  if (cleaned.length === 0) return null;
  let digits = cleaned;
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("0020")) digits = digits.slice(4);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.startsWith("20")) digits = digits.slice(2);
  if (!/^1\d{9}$/.test(digits)) return null;
  if ("0125".indexOf(digits[1]) === -1) return null;
  return { national: `0${digits}`, e164: `+20${digits}` };
}

/** §B.2.1 `collection_accounts.wallet_msisdn` form. */
const WALLET_MSISDN_RE = /^\+201[0125]\d{8}$/;

/**
 * A wallet number in its stored E.164 form (`^\+201[0125]\d{8}$`, §B.2.1), or
 * null. Backs 05's 400 `INVALID_WALLET_NUMBER`.
 */
export function normalizeWalletMsisdn(raw: string | null | undefined): string | null {
  const m = normalizeEgyptMobile(raw);
  if (!m || !WALLET_MSISDN_RE.test(m.e164)) return null;
  return m.e164;
}

/** §B.2.1 `collection_accounts.iban` form. */
const EG_IBAN_RE = /^EG\d{27}$/;

/**
 * An Egyptian IBAN: white space stripped, upper-cased, `^EG\d{27}$`, and the
 * ISO 13616 mod-97 check equal to 1. Returns the compact value or null
 * (backs 05's 400 `INVALID_IBAN`).
 */
export function normalizeIban(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = normalizeDigits(String(raw)).replace(/\s+/g, "").toUpperCase();
  if (!EG_IBAN_RE.test(s)) return null;
  return ibanMod97(s) === 1 ? s : null;
}

// ISO 13616: move the first four characters to the end, letters → 10..35,
// then the remainder mod 97, computed digit by digit (no BigInt needed).
function ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const c = rearranged.charCodeAt(i);
    const chunk = c >= 65 && c <= 90 ? String(c - 55) : rearranged[i];
    for (let j = 0; j < chunk.length; j++) {
      rem = (rem * 10 + (chunk.charCodeAt(j) - 48)) % 97;
    }
  }
  return rem;
}

/** The last 4 digits of a phone (Arabic-Indic allowed), or null. */
export function phoneLast4(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = normalizeDigits(String(raw)).replace(/[^0-9]/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

/**
 * The bank's own style ("ABDELAZEEZ M****", IP-NBE-3): the first word, then
 * the first letter of the second word + "****"; the rest is dropped.
 * "AHMED MOHAMED ABDELRAHMAN" → "AHMED M****"; "محمد احمد علي" → "محمد ا****";
 * one word → "<word> ****"; empty → null.
 */
export function maskPayerName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const words = String(name).trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  if (words.length === 1) return `${words[0]} ****`;
  const firstLetter = Array.from(words[1])[0];
  return `${words[0]} ${firstLetter}****`;
}

export interface AccountMaskInput {
  accountLast4?: string | null;
  walletMsisdn?: string | null;
  ipaHandle?: string | null;
  isPrepaidCard?: boolean | null;
}

/**
 * One ASCII-only mask for the UI (`CollectionAccountDTO.mask`,
 * `CollectionDTO.account.mask`) and every receipt renderer (thermal code
 * pages lack "…"):
 * - with account_last4 → "***0150";
 * - else a wallet → "***" + the last 4 of the msisdn;
 * - else an IPA → "***@instapay";
 * - else (a prepaid card with no digits, or nothing known) → "***".
 */
export function accountMask(a: AccountMaskInput): string {
  const last4 = a.accountLast4 ? phoneLast4(a.accountLast4) : null;
  if (last4) return `***${last4}`;
  const wallet4 = a.walletMsisdn ? phoneLast4(a.walletMsisdn) : null;
  if (wallet4) return `***${wallet4}`;
  if (a.ipaHandle && String(a.ipaHandle).trim() !== "") return "***@instapay";
  return "***";
}
