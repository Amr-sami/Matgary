import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { getShopSettings, saveShopSettings } from "@/lib/repo/settings";
import { logActivity } from "@/lib/repo/activity";

// Multi-store: settings are per (tenant, branch). Reads + writes are scoped
// to the active branch from the cookie context, so each branch shows its
// own header/logo/WhatsApp credentials/message template independently.

export async function GET() {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const data = await getShopSettings(r.ctx.tenantId, r.ctx.branchId);
  return NextResponse.json({ data, branchId: r.ctx.branchId });
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
});

export async function PATCH(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  await saveShopSettings(r.ctx.tenantId, r.ctx.branchId, parsed.data);
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
