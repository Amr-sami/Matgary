// Client-facing settings module. Fetches per-tenant settings from /api/settings
// and exposes the same helpers components already use (substitute, normalizePhone,
// buildWhatsAppLink). The Firestore-backed implementation has been removed.

import { DEFAULT_MESSAGE_TEMPLATE } from "./settings.defaults";

export const DEFAULT_TEMPLATE = DEFAULT_MESSAGE_TEMPLATE;

export type ReceiptLogoSize = "hidden" | "small" | "medium" | "large";
export type ReceiptLanguage = "ar" | "en" | "bilingual";
export type ReceiptFontFamily = "cairo" | "tajawal" | "lemonada";
/** Fixed receipt blocks the renderer knows how to draw. Order is owner-
 *  controlled; arbitrary "custom:<id>" entries may also appear in the order
 *  and reference entries in receiptCustomBlocks. */
export type ReceiptFixedBlock =
  | "logo"
  | "shopInfo"
  | "purchaseDate"
  | "items"
  | "totals"
  | "loyalty"
  | "footer";
/** What lives in receiptBlockOrder: either a fixed block key or a
 *  custom-block reference like "custom:abc123". */
export type ReceiptBlockKey = ReceiptFixedBlock | `custom:${string}`;
export const RECEIPT_FIXED_BLOCKS: readonly ReceiptFixedBlock[] = [
  "logo",
  "shopInfo",
  "purchaseDate",
  "items",
  "totals",
  "loyalty",
  "footer",
];
export const DEFAULT_RECEIPT_BLOCK_ORDER: ReceiptBlockKey[] = [
  "logo",
  "shopInfo",
  "purchaseDate",
  "items",
  "totals",
  "loyalty",
  "footer",
];
export type ReceiptBlockAlign = "right" | "center" | "left";
export interface ReceiptCustomBlock {
  text: string;
  align: ReceiptBlockAlign;
}

export interface ShopSettings {
  autoOpenWhatsApp: boolean;
  messageTemplate: string;
  shopName: string;
  shopPhone: string;
  greenApiEnabled: boolean;
  greenApiInstanceId: string;
  greenApiToken: string;
  greenApiUrl: string;
  /** WhatsApp Business Cloud API (Meta's official). Independent of Green
   *  API — when both are enabled the app prefers Cloud API. Token is
   *  masked on client read; sending happens server-side. */
  whatsappCloudEnabled: boolean;
  whatsappCloudPhoneId: string;
  whatsappCloudToken: string;
  whatsappCloudBusinessId: string;
  /** Phase 6: when both are non-empty, receipts go through this
   *  Meta-approved template instead of as a PDF. */
  receiptTemplateName: string;
  receiptTemplateLanguage: string;
  sendAsPdf: boolean;
  /** Loyalty programme — disabled by default. Per-branch in multi-store. */
  loyaltyEnabled: boolean;
  /** Earn rate: points per EGP spent (e.g. 0.1 = 1 pt per 10 EGP). */
  loyaltyPointsPerEgp: number;
  /** Redeem rate: EGP value of one point (e.g. 0.1 = 1 pt = 0.10 EGP off). */
  loyaltyEgpPerPoint: number;
  /** Receipt customisation — see migration 0017. */
  receiptLogoSize: ReceiptLogoSize;
  receiptFooterText: string;
  receiptLanguage: ReceiptLanguage;
  receiptShowLoyalty: boolean;
  /** Receipt designer — see migration 0029. Logo is stored as a data:image
   *  URI; block order + font are owner-customisable from /settings. */
  receiptLogoUrl: string;
  receiptBlockOrder: ReceiptBlockKey[];
  receiptFontFamily: ReceiptFontFamily;
  /** Owner-defined text blocks the renderer splices in by ID — added in 0030. */
  receiptCustomBlocks: Record<string, ReceiptCustomBlock>;
}

export const DEFAULT_SETTINGS: ShopSettings = {
  autoOpenWhatsApp: true,
  messageTemplate: DEFAULT_TEMPLATE,
  shopName: "",
  shopPhone: "",
  greenApiEnabled: false,
  greenApiInstanceId: "",
  greenApiToken: "",
  greenApiUrl: "",
  whatsappCloudEnabled: false,
  whatsappCloudPhoneId: "",
  whatsappCloudToken: "",
  whatsappCloudBusinessId: "",
  receiptTemplateName: "",
  receiptTemplateLanguage: "",
  sendAsPdf: false,
  loyaltyEnabled: false,
  loyaltyPointsPerEgp: 0,
  loyaltyEgpPerPoint: 0,
  receiptLogoSize: "medium",
  receiptFooterText: "",
  receiptLanguage: "ar",
  receiptShowLoyalty: true,
  receiptLogoUrl: "",
  receiptBlockOrder: DEFAULT_RECEIPT_BLOCK_ORDER,
  receiptFontFamily: "cairo",
  receiptCustomBlocks: {},
};

export interface ReceiptVars {
  customerName: string;
  customerPhone: string;
  invoiceId: string;
  invoiceCode: string;
  totalPrice: string;
  productNames: string;
  date: string;
  shopName: string;
  shopPhone: string;
}

export function substitute(template: string, vars: ReceiptVars): string {
  const lookup = vars as unknown as Record<string, string>;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = lookup[key];
    return v !== undefined ? v : `{${key}}`;
  });
}

export async function fetchShopSettings(): Promise<ShopSettings> {
  // Cacheable per server Cache-Control (private, max-age=60, swr=300).
  const res = await fetch("/api/settings");
  if (!res.ok) return DEFAULT_SETTINGS;
  const json: { data: ShopSettings } = await res.json();
  return { ...DEFAULT_SETTINGS, ...json.data };
}

export async function saveSettings(patch: Partial<ShopSettings>): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
}

export function normalizePhone(phone: string): string | null {
  const cleaned = (phone || "").replace(/\D/g, "");
  if (!cleaned) return null;
  // Egypt: 11-digit local starting with 0 → "20" + rest
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    return "20" + cleaned.slice(1);
  }
  return cleaned;
}

export function buildWhatsAppLink(
  customerPhone: string,
  message: string,
): string | null {
  const normalized = normalizePhone(customerPhone);
  if (!normalized) return null;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}
