import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { getShopSettings, saveShopSettings } from "@/lib/repo/settings";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const data = await getShopSettings(r.ctx.tenantId);
  return NextResponse.json({ data });
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
  sendAsPdf: z.boolean().optional(),
});

export async function PATCH(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  await saveShopSettings(r.ctx.tenantId, parsed.data);
  return NextResponse.json({ ok: true });
}
