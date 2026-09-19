import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/permissions";
import { PlanActionError, patchPlan } from "@/lib/admin/plans";
import { clientIpOrNull } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  labelAr: z.string().min(1).max(80).optional(),
  labelEn: z.string().min(1).max(80).optional(),
  taglineAr: z.string().min(1).max(200).optional(),
  taglineEn: z.string().min(1).max(200).optional(),
  monthlyEgp: z.number().int().min(0).max(99999).optional(),
  purchasable: z.boolean().optional(),
  featuresAr: z.array(z.string().min(1).max(200)).max(15).optional(),
  featuresEn: z.array(z.string().min(1).max(200)).max(15).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const r = await requirePermission("plan.update");
  if (!r.ok) return r.response;
  const { key } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "INVALID" },
      { status: 400 },
    );
  }
  try {
    const updated = await patchPlan({
      adminId: r.session.adminId,
      key,
      patch: parsed.data,
      ifMatch: req.headers.get("if-match"),
      meta: { ip: clientIpOrNull(req), userAgent: req.headers.get("user-agent") },
    });
    return NextResponse.json({ plan: updated });
  } catch (err) {
    if (err instanceof PlanActionError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
