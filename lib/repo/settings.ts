import { and, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { shopSettings } from "@/lib/db/schema";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { cacheDel, cacheRemember, tenantKey } from "@/lib/cache";

// 5 min: settings change rarely, and saveShopSettings busts the key anyway,
// so a stale read window only opens up after a manual edit in the DB.
const SETTINGS_TTL_SEC = 300;
// Multi-store: settings are per (tenant, branch). Each branch has its own
// shop name, logo, WhatsApp credentials, message template — full isolation.
const settingsKey = (tenantId: string, branchId: string) =>
  tenantKey(tenantId, "settings", branchId);

// Sentinel returned to the client in place of the real Green API token. The
// settings UI shows ••••• and only sends a new value when the operator types
// one. PATCH ignores this sentinel so unchanged tokens stay unchanged.
export const TOKEN_PLACEHOLDER = "********";

export interface ShopSettingsDto {
  shopName: string;
  shopPhone: string;
  autoOpenWhatsApp: boolean;
  messageTemplate: string;
  greenApiEnabled: boolean;
  greenApiInstanceId: string;
  greenApiToken: string;
  greenApiUrl: string;
  /** Meta WhatsApp Business Cloud API (the official channel). Sits next to
   *  the Green API fields — when both are enabled, the app prefers Cloud. */
  whatsappCloudEnabled: boolean;
  whatsappCloudPhoneId: string;
  whatsappCloudToken: string;
  whatsappCloudBusinessId: string;
  /** Phase 6: when both are non-empty, receipts go through a
   *  Meta-approved template (utility category) instead of as a PDF.
   *  Empty strings = unconfigured = legacy PDF path. */
  receiptTemplateName: string;
  receiptTemplateLanguage: string;
  sendAsPdf: boolean;
  /** Loyalty programme — disabled by default. Each branch runs its own.
   *  Rates are EGP-denominated:
   *   - earn: 0.1 = 1 point per 10 EGP spent.
   *   - redeem: 0.1 = 1 point worth 0.10 EGP discount.
   *  Both numbers >= 0. The application floors awarded points to int.  */
  loyaltyEnabled: boolean;
  loyaltyPointsPerEgp: number;
  loyaltyEgpPerPoint: number;
  /** Receipt customisation. Defaults match the historical hardcoded layout
   *  so existing tenants see no visual change until they tune them. */
  receiptLogoSize: ReceiptLogoSize;
  receiptFooterText: string;
  receiptLanguage: ReceiptLanguage;
  receiptShowLoyalty: boolean;
  /** Receipt designer (added 0029). Owner uploads a logo + reorders blocks
   *  + picks a font from the trio already loaded by app/layout. */
  receiptLogoUrl: string;
  receiptBlockOrder: ReceiptBlockKey[];
  receiptFontFamily: ReceiptFontFamily;
  receiptCustomBlocks: Record<string, ReceiptCustomBlock>;
}

export type ReceiptFixedBlock =
  | "logo"
  | "shopInfo"
  | "purchaseDate"
  | "items"
  | "totals"
  | "loyalty"
  | "footer";
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
const CUSTOM_BLOCK_TEXT_MAX = 500;
const CUSTOM_BLOCK_ID_RE = /^[a-z0-9]{6,32}$/;

export type ReceiptFontFamily = "cairo" | "tajawal" | "lemonada";
export const RECEIPT_FONT_FAMILIES: readonly ReceiptFontFamily[] = [
  "cairo",
  "tajawal",
  "lemonada",
];
const LOGO_DATA_URI_MAX = 256 * 1024; // ~256 KB after base64 — comfortable for thermal logos.

export type ReceiptLogoSize = "hidden" | "small" | "medium" | "large";
export const RECEIPT_LOGO_SIZES: readonly ReceiptLogoSize[] = [
  "hidden",
  "small",
  "medium",
  "large",
];

export type ReceiptLanguage = "ar" | "en" | "bilingual";
export const RECEIPT_LANGUAGES: readonly ReceiptLanguage[] = [
  "ar",
  "en",
  "bilingual",
];

const FOOTER_MAX = 500;

function clampLogoSize(v: unknown): ReceiptLogoSize {
  return RECEIPT_LOGO_SIZES.includes(v as ReceiptLogoSize)
    ? (v as ReceiptLogoSize)
    : "medium";
}
function clampLanguage(v: unknown): ReceiptLanguage {
  return RECEIPT_LANGUAGES.includes(v as ReceiptLanguage)
    ? (v as ReceiptLanguage)
    : "ar";
}
function clampFontFamily(v: unknown): ReceiptFontFamily {
  return RECEIPT_FONT_FAMILIES.includes(v as ReceiptFontFamily)
    ? (v as ReceiptFontFamily)
    : "cairo";
}
function isFixedBlock(s: string): s is ReceiptFixedBlock {
  return (RECEIPT_FIXED_BLOCKS as readonly string[]).includes(s);
}
function isCustomRef(s: string): s is `custom:${string}` {
  return s.startsWith("custom:") && CUSTOM_BLOCK_ID_RE.test(s.slice(7));
}
/** Accept fixed block keys + "custom:<id>" references. Dedupe, drop unknown
 *  fixed keys, drop custom refs whose id doesn't match the existing custom
 *  block map. Hidden fixed blocks: any fixed block NOT in the stored array
 *  is treated as hidden — we no longer force-append the defaults the way 0029
 *  did, so the owner can actually remove blocks from the receipt. */
function normalizeBlockOrder(
  v: unknown,
  knownCustomIds: ReadonlySet<string>,
): ReceiptBlockKey[] {
  if (!Array.isArray(v)) return [...DEFAULT_RECEIPT_BLOCK_ORDER];
  const seen = new Set<string>();
  const out: ReceiptBlockKey[] = [];
  for (const raw of v) {
    if (typeof raw !== "string" || seen.has(raw)) continue;
    if (isFixedBlock(raw)) {
      seen.add(raw);
      out.push(raw);
    } else if (isCustomRef(raw) && knownCustomIds.has(raw.slice(7))) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}
function clampAlign(v: unknown): ReceiptBlockAlign {
  return v === "right" || v === "center" || v === "left" ? v : "center";
}
function normalizeCustomBlocks(
  v: unknown,
): Record<string, ReceiptCustomBlock> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, ReceiptCustomBlock> = {};
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!CUSTOM_BLOCK_ID_RE.test(id)) continue;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { text?: unknown; align?: unknown };
    if (typeof r.text !== "string") continue;
    out[id] = {
      text: r.text.replace(/\r/g, "").slice(0, CUSTOM_BLOCK_TEXT_MAX),
      align: clampAlign(r.align),
    };
  }
  return out;
}
/** Strip everything except a small allowlist of image data URIs. Returning
 *  empty string is the "no custom logo" signal — receipt falls back to the
 *  static /logo.png so the visual default stays the same as before. */
export function sanitizeLogoDataUri(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) return "";
  if (v.length > LOGO_DATA_URI_MAX) return "";
  if (!/^data:image\/(png|jpe?g|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v))
    return "";
  return v;
}

export const DEFAULT_DTO: ShopSettingsDto = {
  shopName: "",
  shopPhone: "",
  autoOpenWhatsApp: true,
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
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

/** Load settings for the UI — never exposes the raw Green API token. */
export async function getShopSettings(
  tenantId: string,
  branchId: string,
): Promise<ShopSettingsDto> {
  return cacheRemember(settingsKey(tenantId, branchId), SETTINGS_TTL_SEC, () =>
    withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(shopSettings)
        .where(
          and(
            eq(shopSettings.tenantId, tenantId),
            eq(shopSettings.branchId, branchId),
          ),
        )
        .limit(1);
      if (!row) return DEFAULT_DTO;
      return {
        shopName: row.shopName || "",
        shopPhone: row.shopPhone || "",
        autoOpenWhatsApp: row.autoOpenWhatsapp,
        messageTemplate: row.messageTemplate || DEFAULT_MESSAGE_TEMPLATE,
        greenApiEnabled: row.greenApiEnabled,
        greenApiInstanceId: row.greenApiInstanceId || "",
        // Never leak the encrypted blob nor the plaintext token to the client.
        // The placeholder lets the UI show "configured" without revealing it.
        greenApiToken: row.greenApiToken ? TOKEN_PLACEHOLDER : "",
        greenApiUrl: row.greenApiUrl || "",
        whatsappCloudEnabled: row.whatsappCloudEnabled,
        whatsappCloudPhoneId: row.whatsappCloudPhoneId || "",
        // Same placeholder treatment as Green API — never leak the real token.
        whatsappCloudToken: row.whatsappCloudToken ? TOKEN_PLACEHOLDER : "",
        whatsappCloudBusinessId: row.whatsappCloudBusinessId || "",
        receiptTemplateName: row.receiptTemplateName || "",
        receiptTemplateLanguage: row.receiptTemplateLanguage || "",
        sendAsPdf: row.sendAsPdf,
        loyaltyEnabled: row.loyaltyEnabled,
        loyaltyPointsPerEgp: Number(row.loyaltyPointsPerEgp ?? 0),
        loyaltyEgpPerPoint: Number(row.loyaltyEgpPerPoint ?? 0),
        receiptLogoSize: clampLogoSize(row.receiptLogoSize),
        receiptFooterText: row.receiptFooterText ?? "",
        receiptLanguage: clampLanguage(row.receiptLanguage),
        receiptShowLoyalty: row.receiptShowLoyalty,
        receiptLogoUrl: row.logoPath ?? "",
        receiptCustomBlocks: normalizeCustomBlocks(row.receiptCustomBlocks),
        receiptBlockOrder: normalizeBlockOrder(
          row.receiptBlockOrder,
          new Set(Object.keys(normalizeCustomBlocks(row.receiptCustomBlocks))),
        ),
        receiptFontFamily: clampFontFamily(row.receiptFontFamily),
      };
    }),
  );
}

/** Server-only: decrypt and return the real WhatsApp Cloud API token for
 *  outbound Meta Graph calls. Mirrors getGreenApiCredentials(). */
export async function getWhatsAppCloudCredentials(
  tenantId: string,
  branchId: string,
): Promise<{
  enabled: boolean;
  phoneId: string;
  token: string;
  businessId: string;
  sendAsPdf: boolean;
}> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(shopSettings)
      .where(
        and(
          eq(shopSettings.tenantId, tenantId),
          eq(shopSettings.branchId, branchId),
        ),
      )
      .limit(1);
    if (!row) {
      return {
        enabled: false,
        phoneId: "",
        token: "",
        businessId: "",
        sendAsPdf: false,
      };
    }
    return {
      enabled: row.whatsappCloudEnabled,
      phoneId: row.whatsappCloudPhoneId || "",
      token: row.whatsappCloudToken ? decryptSecret(row.whatsappCloudToken) : "",
      businessId: row.whatsappCloudBusinessId || "",
      sendAsPdf: row.sendAsPdf,
    };
  });
}

/** Server-only: decrypt and return the real Green API token for outbound API calls. */
export async function getGreenApiCredentials(
  tenantId: string,
  branchId: string,
): Promise<{
  enabled: boolean;
  instanceId: string;
  token: string;
  url: string;
  sendAsPdf: boolean;
}> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(shopSettings)
      .where(
        and(
          eq(shopSettings.tenantId, tenantId),
          eq(shopSettings.branchId, branchId),
        ),
      )
      .limit(1);
    if (!row) {
      return { enabled: false, instanceId: "", token: "", url: "", sendAsPdf: false };
    }
    return {
      enabled: row.greenApiEnabled,
      instanceId: row.greenApiInstanceId || "",
      token: row.greenApiToken ? decryptSecret(row.greenApiToken) : "",
      url: row.greenApiUrl || "",
      sendAsPdf: row.sendAsPdf,
    };
  });
}

export async function saveShopSettings(
  tenantId: string,
  branchId: string,
  patch: Partial<ShopSettingsDto>,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.shopName !== undefined) set.shopName = patch.shopName;
    if (patch.shopPhone !== undefined) set.shopPhone = patch.shopPhone || null;
    if (patch.autoOpenWhatsApp !== undefined)
      set.autoOpenWhatsapp = patch.autoOpenWhatsApp;
    if (patch.messageTemplate !== undefined)
      set.messageTemplate = patch.messageTemplate;
    if (patch.greenApiEnabled !== undefined)
      set.greenApiEnabled = patch.greenApiEnabled;
    if (patch.greenApiInstanceId !== undefined)
      set.greenApiInstanceId = patch.greenApiInstanceId || null;
    if (patch.greenApiToken !== undefined) {
      // Token cycle:
      //  - empty string -> clear stored credential
      //  - placeholder  -> no change (UI didn't touch it)
      //  - anything else -> encrypt and store
      if (patch.greenApiToken === "") {
        set.greenApiToken = null;
      } else if (patch.greenApiToken !== TOKEN_PLACEHOLDER) {
        set.greenApiToken = encryptSecret(patch.greenApiToken);
      }
    }
    if (patch.greenApiUrl !== undefined)
      set.greenApiUrl = patch.greenApiUrl || null;
    if (patch.whatsappCloudEnabled !== undefined)
      set.whatsappCloudEnabled = patch.whatsappCloudEnabled;
    if (patch.whatsappCloudPhoneId !== undefined)
      set.whatsappCloudPhoneId = patch.whatsappCloudPhoneId || null;
    if (patch.whatsappCloudToken !== undefined) {
      // Same cycle as Green API: empty -> clear, placeholder -> no-op,
      // anything else -> encrypt and store.
      if (patch.whatsappCloudToken === "") {
        set.whatsappCloudToken = null;
      } else if (patch.whatsappCloudToken !== TOKEN_PLACEHOLDER) {
        set.whatsappCloudToken = encryptSecret(patch.whatsappCloudToken);
      }
    }
    if (patch.whatsappCloudBusinessId !== undefined)
      set.whatsappCloudBusinessId = patch.whatsappCloudBusinessId || null;
    if (patch.receiptTemplateName !== undefined) {
      const v = patch.receiptTemplateName.trim();
      set.receiptTemplateName = v.length > 0 ? v.slice(0, 120) : null;
    }
    if (patch.receiptTemplateLanguage !== undefined) {
      const v = patch.receiptTemplateLanguage.trim();
      set.receiptTemplateLanguage = v.length > 0 ? v.slice(0, 20) : null;
    }
    if (patch.sendAsPdf !== undefined) set.sendAsPdf = patch.sendAsPdf;
    if (patch.loyaltyEnabled !== undefined)
      set.loyaltyEnabled = patch.loyaltyEnabled;
    if (patch.loyaltyPointsPerEgp !== undefined) {
      // Clamp to a sensible range. >100 points per EGP is almost certainly
      // a typo; <0 is nonsensical.
      const v = Math.max(0, Math.min(100, Number(patch.loyaltyPointsPerEgp)));
      set.loyaltyPointsPerEgp = v.toFixed(4);
    }
    if (patch.loyaltyEgpPerPoint !== undefined) {
      const v = Math.max(0, Math.min(1000, Number(patch.loyaltyEgpPerPoint)));
      set.loyaltyEgpPerPoint = v.toFixed(4);
    }
    if (patch.receiptLogoSize !== undefined)
      set.receiptLogoSize = clampLogoSize(patch.receiptLogoSize);
    if (patch.receiptFooterText !== undefined)
      // Cap to FOOTER_MAX so a runaway paste can't blow up receipt rendering;
      // strip carriage returns so the textarea round-trips cleanly across OSes.
      set.receiptFooterText = String(patch.receiptFooterText)
        .replace(/\r/g, "")
        .slice(0, FOOTER_MAX);
    if (patch.receiptLanguage !== undefined)
      set.receiptLanguage = clampLanguage(patch.receiptLanguage);
    if (patch.receiptShowLoyalty !== undefined)
      set.receiptShowLoyalty = !!patch.receiptShowLoyalty;
    if (patch.receiptLogoUrl !== undefined) {
      // Empty string clears the column → receipt falls back to the bundled
      // /logo.png. Anything else has to pass the data-URI sanitiser; bad
      // values are dropped silently to avoid a 500 from a malformed paste.
      const clean = sanitizeLogoDataUri(patch.receiptLogoUrl);
      set.logoPath = clean.length > 0 ? clean : null;
    }
    // Custom blocks must be written FIRST so the block-order normaliser can
    // see the new IDs in the same transaction. If both fields are present,
    // we use the incoming custom-block map directly; otherwise we look up
    // the stored set so the normaliser still validates "custom:<id>" refs.
    let knownCustomIds: Set<string> | null = null;
    if (patch.receiptCustomBlocks !== undefined) {
      const normalised = normalizeCustomBlocks(patch.receiptCustomBlocks);
      set.receiptCustomBlocks = normalised;
      knownCustomIds = new Set(Object.keys(normalised));
    }
    if (patch.receiptBlockOrder !== undefined) {
      if (!knownCustomIds) {
        const [row] = await tx
          .select({ blocks: shopSettings.receiptCustomBlocks })
          .from(shopSettings)
          .where(
            and(
              eq(shopSettings.tenantId, tenantId),
              eq(shopSettings.branchId, branchId),
            ),
          )
          .limit(1);
        knownCustomIds = new Set(
          Object.keys(normalizeCustomBlocks(row?.blocks ?? {})),
        );
      }
      set.receiptBlockOrder = normalizeBlockOrder(
        patch.receiptBlockOrder,
        knownCustomIds,
      );
    }
    if (patch.receiptFontFamily !== undefined)
      set.receiptFontFamily = clampFontFamily(patch.receiptFontFamily);

    await tx
      .update(shopSettings)
      .set(set)
      .where(
        and(
          eq(shopSettings.tenantId, tenantId),
          eq(shopSettings.branchId, branchId),
        ),
      );
  });
  // Co-located bust: the only place that mutates settings is also the only
  // place that knows what to drop from cache.
  await cacheDel(settingsKey(tenantId, branchId));
}
