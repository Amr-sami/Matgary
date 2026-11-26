// POST /api/admin/tenants/[id]/enable-trial
//
// Permission: tenant.extend_trial (ops + super_admin can both run it; the
// action is reversible and lower-impact than suspend). Idempotent: calling
// again simply sets a new N-day window from now. Audits as
// `tenant.enable_trial`.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/permissions";
import {
  TenantActionError,
  enableTrial,
} from "@/lib/admin/tenant-actions";
import { clientIpOrNull } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  days: z.number().int().min(1).max(90),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("tenant.extend_trial");
  if (!r.ok) return r.response;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "INVALID" },
      { status: 400 },
    );
  }

  try {
    const result = await enableTrial(r.session.adminId, id, parsed.data.days, {
      ip: clientIpOrNull(req),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({
      ok: true,
      newTrialEndsAt: result.newTrialEndsAt.toISOString(),
      created: result.created,
    });
  } catch (err) {
    if (err instanceof TenantActionError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
