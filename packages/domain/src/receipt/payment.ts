// Receipt payment-method row (mobile-dev-docs/15-digital-collections/13 §4.15).
//
// Every receipt renderer — thermal ESC/POS text + raster (escpos/receipt.ts),
// the mobile HTML/PDF (apps/mobile/src/receipt/html.ts), the web receipt and
// invoice receipt, the WhatsApp PDF (apps/web/lib/pdfReceipt.ts) — prints the
// same rows from this one helper:
//   - only for instapay, wallet and card (D13-5); cash and deferred receipts
//     stay byte-identical to before;
//   - the receiving account as an ASCII mask (06 accountMask: "***0150",
//     "***@instapay"), at most 4 (split transfers, Q5) — thermal code pages
//     lack "•" and "…", so anything else is dropped;
//   - NEVER a confirmation status: the customer's paper says how they paid,
//     not whether the owner has checked it yet (02 US-M1-23, Q20).
//
// Pure and Hermes-safe: no Intl, no lookbehind, no I/O.

export type ReceiptLang = "ar" | "en" | "bilingual";

export interface ReceiptPayment {
  /** The sale's payment method (`sales.payment_method`). */
  method: string;
  /** Masks of the receiving account(s), from CollectionAccountDTO.mask. */
  accountMasks?: readonly string[] | null;
}

export const RECEIPT_PAYMENT_LABELS = {
  paidBy: { en: "PAID BY", ar: "طريقة الدفع" },
  instapay: { en: "InstaPay", ar: "إنستاباي" },
  wallet: { en: "Mobile wallet", ar: "محفظة موبايل" },
  card: { en: "Card", ar: "بطاقة" },
} as const;

/** D13-5: the methods that print a row. */
const PRINTED = new Set(["instapay", "wallet", "card"]);
/** ASCII only (06 §4.3); 1..32 chars. */
const MASK_RE = /^[A-Za-z0-9*@._ -]{1,32}$/;
/** Split transfers carry at most 4 parts (Q5). */
export const RECEIPT_MAX_MASKS = 4;

type Pair = { en: string; ar: string };

/**
 * The rows to print after the totals, or [] when nothing should print.
 * `joiner` separates the two languages in bilingual mode: " · " on the web /
 * HTML receipts, " / " on ESC/POS. `order` is the bilingual order: "en-ar"
 * (default; the web and HTML receipts put English first) or "ar-en" (the
 * ESC/POS ticket's own labels read "الإجمالي / TOTAL").
 */
export function receiptPaymentRows(
  p: ReceiptPayment | null | undefined,
  lang: ReceiptLang,
  joiner = " · ",
  order: "en-ar" | "ar-en" = "en-ar",
): Array<{ label: string; value: string }> {
  if (!p || typeof p !== "object" || typeof p.method !== "string" || !PRINTED.has(p.method)) return [];
  const pick = (x: Pair): string =>
    lang === "ar" ? x.ar : lang === "en" ? x.en : order === "ar-en" ? `${x.ar}${joiner}${x.en}` : `${x.en}${joiner}${x.ar}`;
  const method = pick(RECEIPT_PAYMENT_LABELS[p.method as "instapay" | "wallet" | "card"]);
  const label = pick(RECEIPT_PAYMENT_LABELS.paidBy);
  // `p` may come straight from a request body (the WhatsApp PDF routes take
  // the invoice as z.unknown()), so every field is checked, never trusted.
  const raw: readonly unknown[] = Array.isArray(p.accountMasks) ? p.accountMasks : [];
  const masks = raw
    .filter((m): m is string => typeof m === "string" && MASK_RE.test(m))
    .slice(0, RECEIPT_MAX_MASKS);
  if (masks.length === 1) return [{ label, value: `${method} ${masks[0]}` }];
  return [{ label, value: method }, ...masks.map((m) => ({ label: "", value: m }))];
}
