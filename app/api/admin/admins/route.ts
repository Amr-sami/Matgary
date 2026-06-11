import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/permissions";
import { AdminMgmtError, addAdmin, listAdmins } from "@/lib/admin/admins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

export async function GET() {
  const r = await requirePermission("admin.manage");
  if (!r.ok) return r.response;
  const data = await listAdmins(r.session.adminId);
  return NextResponse.json({ data });
}

const createSchema = z.object({
  email: z.string().email().max(200),
  displayName: z.string().min(1).max(80),
  role: z.enum(["super_admin", "ops_admin"]),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("admin.manage");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "INVALID" },
      { status: 400 },
    );
  }
  try {
    const created = await addAdmin(
      r.session.adminId,
      parsed.data,
      { ip: clientIp(req), userAgent: req.headers.get("user-agent") },
    );
    return NextResponse.json(
      { id: created.id, tempPassword: created.tempPassword },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof AdminMgmtError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
