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
  sendAsPdf: boolean;
  /** Loyalty programme — disabled by default. Each branch runs its own.
   *  Rates are EGP-denominated:
   *   - earn: 0.1 = 1 point per 10 EGP spent.
   *   - redeem: 0.1 = 1 point worth 0.10 EGP discount.
   *  Both numbers >= 0. The application floors awarded points to int.  */
  loyaltyEnabled: boolean;
  loyaltyPointsPerEgp: number;
  loyaltyEgpPerPoint: number;
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
  sendAsPdf: false,
  loyaltyEnabled: false,
  loyaltyPointsPerEgp: 0,
  loyaltyEgpPerPoint: 0,
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
        sendAsPdf: row.sendAsPdf,
        loyaltyEnabled: row.loyaltyEnabled,
        loyaltyPointsPerEgp: Number(row.loyaltyPointsPerEgp ?? 0),
        loyaltyEgpPerPoint: Number(row.loyaltyEgpPerPoint ?? 0),
      };
    }),
  );
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
