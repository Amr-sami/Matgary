import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requirePermissionWithBranch,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { SETTINGS_CACHE, cacheHeaders } from "@/lib/api/cache-headers";
import { can } from "@/lib/permissions";
import {
  TOKEN_PLACEHOLDER,
  getShopSettings,
  saveShopSettings,
  type ShopSettingsDto,
} from "@/lib/repo/settings";
import { logActivity } from "@/lib/repo/activity";

// Multi-store: settings are per (tenant, branch). Reads + writes are scoped
// to the active branch from the cookie context, so each branch shows its
// own header/logo/WhatsApp credentials/message template independently.

/**
 * WhatsApp credential fields — only a caller with `manage_whatsapp` sees
 * their values (doc 14 §3.1 C3). The tokens are already masked to
 * TOKEN_PLACEHOLDER by the repo; the instance / phone-number / business ids
 * are the other half of the credential pair and get the same treatment here.
 *
 * Masked to the placeholder rather than blanked: the web POS decides whether
 * a server-side sender is configured from the TRUTHINESS of these fields
 * (`components/sales/SaleForm.tsx` — `!!settings.greenApiInstanceId &&
 * !!settings.greenApiToken`), so a cashier must still see "configured" or
 * every till silently falls back to the wa.me popup. The placeholder leaks
 * exactly one bit (set / not set), keeps the DTO shape for every client that
 * types `data` as ShopSettingsDto, and is the value the repo's write cycle
 * treats as "no change" (`saveShopSettings`), so a draft that round-trips
 * through this GET cannot overwrite a credential.
 */
const WHATSAPP_CREDENTIAL_KEYS = [
  "greenApiInstanceId",
  "greenApiToken",
  "greenApiUrl",
  "whatsappCloudPhoneId",
  "whatsappCloudToken",
  "whatsappCloudBusinessId",
] as const satisfies readonly (keyof ShopSettingsDto)[];

function stripWhatsAppCredentials(data: ShopSettingsDto): ShopSettingsDto {
  const out = { ...data };
  for (const k of WHATSAPP_CREDENTIAL_KEYS) out[k] = data[k] ? TOKEN_PLACEHOLDER : "";
  return out;
}

// GET stays open to every member of the tenant: the receipt (shop name,
// phone, logo, block order, footer, loyalty flags) is rendered by the POS on
// both clients — `components/sales/Receipt.tsx`, `SaleForm.tsx`,
// `apps/mobile/src/receipt/share.ts` — and cashiers hold neither
// `view_settings` nor `manage_whatsapp` (DEFAULT_STAFF_PERMISSIONS). Gating
// the read on `view_settings` would break receipt printing for every default
// staff row, which is why doc 14 §3.1 C3 says "return the receipt fields
// under any-member and hide only the secrets". The secrets are the gate.
export async function GET() {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const full = await getShopSettings(r.ctx.tenantId, r.ctx.branchId);
  const data = can(r.ctx, "manage_whatsapp") ? full : stripWhatsAppCredentials(full);
  return NextResponse.json(
    { data, branchId: r.ctx.branchId },
    { headers: cacheHeaders(SETTINGS_CACHE) },
  );
}

const patchSchema = z.object({
  shopName: z.string().max(120).optional(),
  shopPhone: z.string().max(40).optional(),
  autoOpenWhatsApp: z.boolean().optional(),
  messageTemplate: z.string().max(2000).optional(),
  greenApiEnabled: z.boolean().optional(),
  greenApiInstanceId: z.string().max(80).optional(),
  greenApiToken: z.string().max(200).optional(),
  greenApiUrl: z.string().max(200).optional(),
  // Meta WhatsApp Cloud API. Phone-number IDs are ~15-17 digits, tokens
  // are JWT-ish blobs that can be quite long — cap generously.
  whatsappCloudEnabled: z.boolean().optional(),
  whatsappCloudPhoneId: z.string().max(40).optional(),
  whatsappCloudToken: z.string().max(500).optional(),
  whatsappCloudBusinessId: z.string().max(40).optional(),
  // Phase 6 receipt-template selection. Empty string clears.
  receiptTemplateName: z.string().max(120).optional(),
  receiptTemplateLanguage: z.string().max(20).optional(),
  sendAsPdf: z.boolean().optional(),
  // Loyalty programme. Rates are clamped server-side too — accept anything
  // a non-negative number can be, server enforces the safe ceiling.
  loyaltyEnabled: z.boolean().optional(),
  loyaltyPointsPerEgp: z.number().min(0).max(100).optional(),
  loyaltyEgpPerPoint: z.number().min(0).max(1000).optional(),
  // Receipt customisation
  receiptLogoSize: z.enum(["hidden", "small", "medium", "large"]).optional(),
  receiptFooterText: z.string().max(500).optional(),
  receiptLanguage: z.enum(["ar", "en", "bilingual"]).optional(),
  receiptShowLoyalty: z.boolean().optional(),
  // Receipt designer (0029). The logo URL is a data:image URI; the repo
  // sanitiser caps it at ~256 KB and rejects anything that isn't a known
  // image type so the 500 KB ceiling here is just a defence-in-depth cap.
  receiptLogoUrl: z.string().max(500_000).optional(),
  // Receipt block order: fixed-block strings OR "custom:<id>" refs. The repo
  // normalises against the known custom IDs and drops anything unrecognised,
  // so the schema here just needs to allow the shape.
  receiptBlockOrder: z.array(z.string().max(50)).max(64).optional(),
  receiptFontFamily: z.enum(["cairo", "tajawal", "lemonada"]).optional(),
  receiptCustomBlocks: z
    .record(
      z.string(),
      z.object({
        text: z.string().max(500),
        align: z.enum(["right", "center", "left"]),
      }),
    )
    .optional(),
});

export async function PATCH(req: NextRequest) {
  // `manage_whatsapp` is the "shop settings + WhatsApp creds" permission
  // (lib/permissions.ts) — the same one the web /whatsapp page and the
  // mobile Settings tiles check. Branch-aware twin of requirePermissionAudited:
  // audit mode until PERMISSION_ENFORCE_WRITES=1, then 403.
  const r = await requirePermissionWithBranch("manage_whatsapp");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  // Defence in depth, independent of PERMISSION_ENFORCE_WRITES: in audit
  // mode the gate above logs and lets the request through, and the web
  // /settings page (reachable with `view_settings`) saves its ENTIRE draft —
  // which, after the GET masking above, carries placeholders / blanks for
  // the six credential fields. Left in, an empty string would null the stored
  // token (`saveShopSettings`: "empty string -> clear stored credential") and
  // a placeholder would be written as the instance / phone id. So a caller
  // without `manage_whatsapp` may change the receipt, loyalty and shop fields
  // the page shows, but never the credentials.
  if (!can(r.ctx, "manage_whatsapp")) {
    for (const k of WHATSAPP_CREDENTIAL_KEYS) delete parsed.data[k];
  }
  // receiptBlockOrder is widened to string[] by the zod schema (so it can
  // accept "custom:<id>" entries without enumerating them); the repo
  // normaliser will drop anything unknown. Cast through unknown to apologise.
  await saveShopSettings(
    r.ctx.tenantId,
    r.ctx.branchId,
    parsed.data as unknown as Parameters<typeof saveShopSettings>[2],
  );
  // Don't echo secrets (greenApiToken, whatsappCloudToken) into audit metadata.
  const safeChanged = Object.keys(parsed.data).filter(
    (k) => k !== "greenApiToken" && k !== "whatsappCloudToken",
  );
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "settings.update",
    category: "settings",
    branchId: r.ctx.branchId,
    metadata: { changed: safeChanged },
  });
  return NextResponse.json({ ok: true });
}
