import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { shopSettings } from "@/lib/db/schema";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

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
};

/** Load settings for the UI — never exposes the raw Green API token. */
export async function getShopSettings(
  tenantId: string,
): Promise<ShopSettingsDto> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(shopSettings)
      .where(eq(shopSettings.tenantId, tenantId))
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
    };
  });
}

/** Server-only: decrypt and return the real Green API token for outbound API calls. */
export async function getGreenApiCredentials(
  tenantId: string,
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
      .where(eq(shopSettings.tenantId, tenantId))
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

    await tx
      .update(shopSettings)
      .set(set)
      .where(eq(shopSettings.tenantId, tenantId));
  });
}
