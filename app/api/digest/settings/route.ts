import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import { getDigestSettings, upsertDigestSettings } from "@/lib/repo/digest-runs";
import { logActivity } from "@/lib/repo/activity";

export async function GET() {
  const r = await requirePermission("manage_digest_settings");
  if (!r.ok) return r.response;
  const settings = await getDigestSettings(r.ctx.tenantId);
  return NextResponse.json({ settings });
}

const schema = z.object({
  enabled: z.boolean().optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
  // Free-form so we accept Egyptian local format ("01001112233"), E.164
  // ("+201001112233"), and the form's trimmed-blank state ("" → null).
  ownerPhone: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .transform((v) => {
      if (v == null) return v;
      const trimmed = v.trim();
      return trimmed === "" ? null : trimmed;
    }),
  sendOnEmpty: z.boolean().optional(),
  emailFallback: z.boolean().optional(),
  extraRecipients: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        phone: z.string().nullable().optional(),
        email: z.string().email().nullable().optional(),
        locale: z.enum(["ar", "en"]).nullable().optional(),
      }),
    )
    .optional(),
  managersSubscribed: z.array(z.string().uuid()).optional(),
});

export async function PATCH(req: NextRequest) {
  const r = await requirePermission("manage_digest_settings");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  const updated = await upsertDigestSettings(r.ctx.tenantId, parsed.data);
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "digest.settings_changed",
    category: "settings",
    metadata: { fields: Object.keys(parsed.data) },
  });
  return NextResponse.json({ settings: updated });
}
