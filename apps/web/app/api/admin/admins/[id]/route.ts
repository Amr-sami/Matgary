import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/permissions";
import {
  AdminMgmtError,
  deleteAdmin,
  patchAdmin,
} from "@/lib/admin/admins";
import { clientIpOrNull } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  role: z.enum(["super_admin", "ops_admin"]).optional(),
  disabled: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("admin.manage");
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "INVALID" },
      { status: 400 },
    );
  }
  try {
    await patchAdmin(r.session.adminId, id, parsed.data, {
      ip: clientIpOrNull(req),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AdminMgmtError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("admin.manage");
  if (!r.ok) return r.response;
  const { id } = await params;
  try {
    await deleteAdmin(r.session.adminId, id, {
      ip: clientIpOrNull(req),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AdminMgmtError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
