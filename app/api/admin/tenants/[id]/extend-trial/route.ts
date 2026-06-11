import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/permissions";
import {
  TenantActionError,
  extendTrial,
} from "@/lib/admin/tenant-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  days: z.number().int().min(1).max(90),
  reason: z.string().max(500).nullable().optional(),
});

function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Either role can extend a trial.
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
    const result = await extendTrial(
      r.session.adminId,
      id,
      parsed.data.days,
      parsed.data.reason ?? null,
      {
        ip: clientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
    );
    return NextResponse.json({
      ok: true,
      newTrialEndsAt: result.newTrialEndsAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof TenantActionError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
