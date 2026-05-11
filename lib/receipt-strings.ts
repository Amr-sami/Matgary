// Receipt label localisation. The receipt's language setting decides which
// label set we render; "bilingual" stacks the English label on top and the
// Arabic translation below in a smaller font on the same row.
//
// Keep the keys minimal — only the strings the receipt actually prints. We
// don't centralise free-form copy (shop name, footer text, slogan) here
// because those are tenant-controlled.

import type { ReceiptLanguage } from "./settings";

interface LabelPair {
  en: string;
  ar: string;
}

export const RECEIPT_LABELS = {
  receipt: { en: "*** RECEIPT ***", ar: "*** فاتورة ***" },
  subtotal: { en: "SUBTOTAL", ar: "المجموع" },
  discount: { en: "DISCOUNT", ar: "الخصم" },
  lineDiscounts: { en: "LINE DISCOUNTS", ar: "خصومات الأصناف" },
  orderDiscount: { en: "ORDER DISCOUNT", ar: "خصم الفاتورة" },
  loyaltyPoints: { en: "POINTS REDEEMED", ar: "نقاط مستخدمة" },
  loyaltyCredit: { en: "CREDIT APPLIED", ar: "رصيد مستخدم" },
  loyaltyEarned: { en: "POINTS EARNED", ar: "نقاط مكتسبة" },
  walletBalance: { en: "WALLET BALANCE", ar: "رصيد المحفظة" },
  total: { en: "TOTAL AMOUNT", ar: "الإجمالي" },
  thankYou: { en: "THANK YOU FOR SHOPPING!", ar: "شكراً لتسوقكم معنا" },
  brand: { en: "BRAND", ar: "الماركة" },
  scanToVisit: { en: "SCAN TO VISIT", ar: "امسح للزيارة" },
  tel: { en: "TEL", ar: "هاتف" },
} as const satisfies Record<string, LabelPair>;

export type ReceiptLabelKey = keyof typeof RECEIPT_LABELS;

/** Pick the printed label for a given language. */
export function rl(key: ReceiptLabelKey, lang: ReceiptLanguage): string {
  const pair = RECEIPT_LABELS[key];
  if (lang === "ar") return pair.ar;
  if (lang === "en") return pair.en;
  // bilingual: English first (matches the LTR receipt direction) then Arabic
  // separated by a thin spacer so it reads as one cell on a single line.
  return `${pair.en} · ${pair.ar}`;
}
