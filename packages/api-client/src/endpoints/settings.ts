import type { ApiClient } from "../http";

/**
 * Shop settings — `GET/PATCH /api/settings` (apps/web/app/api/settings/route.ts).
 *
 * Settings are per (tenant, branch): the server scopes both verbs to the
 * branch carried by X-Branch-Id, so callers must key their caches on the
 * active branch too.
 *
 * The DTO mirrors `ShopSettingsDto` in apps/web/lib/repo/settings.ts. The
 * WhatsApp credential fields ride along in the GET (tokens come back as the
 * "********" sentinel) but are read-only on mobile by design — nobody pastes
 * a Meta Cloud API token on a phone (doc 02 §1.1 row 20).
 */

export type ReceiptLogoSize = "hidden" | "small" | "medium" | "large";
export type ReceiptLanguage = "ar" | "en" | "bilingual";
export type ReceiptFontFamily = "cairo" | "tajawal" | "lemonada";
export type ReceiptBlockAlign = "right" | "center" | "left";

export type ReceiptFixedBlock =
  | "logo"
  | "shopInfo"
  | "purchaseDate"
  | "items"
  | "totals"
  | "loyalty"
  | "footer";
/** Fixed block keys, or `custom:<id>` refs into `receiptCustomBlocks`. */
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
export const DEFAULT_RECEIPT_BLOCK_ORDER: readonly ReceiptBlockKey[] = [
  ...RECEIPT_FIXED_BLOCKS,
];
export const RECEIPT_LOGO_SIZES: readonly ReceiptLogoSize[] = [
  "hidden",
  "small",
  "medium",
  "large",
];
export const RECEIPT_LANGUAGES: readonly ReceiptLanguage[] = ["ar", "en", "bilingual"];
export const RECEIPT_FONT_FAMILIES: readonly ReceiptFontFamily[] = [
  "cairo",
  "tajawal",
  "lemonada",
];
export const RECEIPT_BLOCK_ALIGNS: readonly ReceiptBlockAlign[] = ["right", "center", "left"];

/** Server caps: route.ts zod schema / repo sanitiser. */
export const SHOP_NAME_MAX = 120;
export const SHOP_PHONE_MAX = 40;
export const RECEIPT_FOOTER_MAX = 500;
export const CUSTOM_BLOCK_TEXT_MAX = 500;
export const LOYALTY_POINTS_PER_EGP_MAX = 100;
export const LOYALTY_EGP_PER_POINT_MAX = 1000;

export interface ReceiptCustomBlock {
  text: string;
  align: ReceiptBlockAlign;
}

export interface ShopSettings {
  shopName: string;
  shopPhone: string;
  autoOpenWhatsApp: boolean;
  messageTemplate: string;
  greenApiEnabled: boolean;
  greenApiInstanceId: string;
  greenApiToken: string;
  greenApiUrl: string;
  whatsappCloudEnabled: boolean;
  whatsappCloudPhoneId: string;
  whatsappCloudToken: string;
  whatsappCloudBusinessId: string;
  receiptTemplateName: string;
  receiptTemplateLanguage: string;
  sendAsPdf: boolean;
  loyaltyEnabled: boolean;
  /** 0.1 = 1 point per 10 EGP spent. */
  loyaltyPointsPerEgp: number;
  /** 0.1 = 1 point worth 0.10 EGP discount. */
  loyaltyEgpPerPoint: number;
  receiptLogoSize: ReceiptLogoSize;
  receiptFooterText: string;
  receiptLanguage: ReceiptLanguage;
  receiptShowLoyalty: boolean;
  /** data:image URI (≤ ~256 KB after the repo sanitiser) or "". */
  receiptLogoUrl: string;
  receiptBlockOrder: ReceiptBlockKey[];
  receiptFontFamily: ReceiptFontFamily;
  receiptCustomBlocks: Record<string, ReceiptCustomBlock>;
}

export interface ShopSettingsResponse {
  data: ShopSettings;
  /** The branch the settings were read for — the X-Branch-Id resolution. */
  branchId: string;
}

/** Every field `PATCH /api/settings` accepts. All optional; omit = unchanged. */
export type ShopSettingsPatch = Partial<
  Pick<
    ShopSettings,
    | "shopName"
    | "shopPhone"
    | "autoOpenWhatsApp"
    | "messageTemplate"
    | "greenApiEnabled"
    | "greenApiInstanceId"
    | "greenApiToken"
    | "greenApiUrl"
    | "whatsappCloudEnabled"
    | "whatsappCloudPhoneId"
    | "whatsappCloudToken"
    | "whatsappCloudBusinessId"
    | "receiptTemplateName"
    | "receiptTemplateLanguage"
    | "sendAsPdf"
    | "loyaltyEnabled"
    | "loyaltyPointsPerEgp"
    | "loyaltyEgpPerPoint"
    | "receiptLogoSize"
    | "receiptFooterText"
    | "receiptLanguage"
    | "receiptShowLoyalty"
    | "receiptLogoUrl"
    | "receiptBlockOrder"
    | "receiptFontFamily"
    | "receiptCustomBlocks"
  >
>;

/** The fields the Store-info screen owns. */
export const STORE_SETTINGS_FIELDS = [
  "shopName",
  "shopPhone",
  "loyaltyEnabled",
  "loyaltyPointsPerEgp",
  "loyaltyEgpPerPoint",
] as const satisfies readonly (keyof ShopSettingsPatch)[];

/** The fields the Receipt designer screen owns. */
export const RECEIPT_SETTINGS_FIELDS = [
  "receiptLogoSize",
  "receiptFooterText",
  "receiptLanguage",
  "receiptShowLoyalty",
  "receiptFontFamily",
  "receiptBlockOrder",
  "receiptCustomBlocks",
] as const satisfies readonly (keyof ShopSettingsPatch)[];

/** Active-branch settings (owner-only page on the web, `requireTenantWithBranch` on the API). */
export async function getShopSettings(client: ApiClient): Promise<ShopSettingsResponse> {
  return client.request<ShopSettingsResponse>("/api/settings");
}

/** Partial update; the server normalises block order / custom blocks and clamps rates. */
export async function updateShopSettings(
  client: ApiClient,
  patch: ShopSettingsPatch,
): Promise<{ ok: true }> {
  return client.request<{ ok: true }>("/api/settings", { method: "PATCH", body: patch });
}

/**
 * Deep-equal for the fields a screen owns, so "dirty" is computed the same
 * way the web's `isEqualSettings` does (block order element-wise, custom
 * blocks by id + text + align).
 */
export function settingsFieldsEqual(
  a: Partial<ShopSettings>,
  b: Partial<ShopSettings>,
  fields: readonly (keyof ShopSettings)[],
): boolean {
  for (const f of fields) {
    const x = a[f];
    const y = b[f];
    if (f === "receiptBlockOrder") {
      const ax = (x ?? []) as ReceiptBlockKey[];
      const ay = (y ?? []) as ReceiptBlockKey[];
      if (ax.length !== ay.length || ax.some((k, i) => k !== ay[i])) return false;
      continue;
    }
    if (f === "receiptCustomBlocks") {
      const ax = (x ?? {}) as Record<string, ReceiptCustomBlock>;
      const ay = (y ?? {}) as Record<string, ReceiptCustomBlock>;
      const ka = Object.keys(ax);
      const kb = Object.keys(ay);
      if (ka.length !== kb.length) return false;
      for (const id of ka) {
        const p = ax[id];
        const q = ay[id];
        if (!q || p.text !== q.text || p.align !== q.align) return false;
      }
      continue;
    }
    if (x !== y) return false;
  }
  return true;
}

/** Pick only the owned fields that actually changed — the PATCH body. */
export function diffSettings(
  base: Partial<ShopSettings>,
  draft: Partial<ShopSettings>,
  fields: readonly (keyof ShopSettingsPatch)[],
): ShopSettingsPatch {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!settingsFieldsEqual(base, draft, [f])) out[f] = draft[f];
  }
  return out as ShopSettingsPatch;
}
