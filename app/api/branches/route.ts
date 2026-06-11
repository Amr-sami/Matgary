import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  getAccessibleBranches,
  resolveActiveBranch,
} from "@/lib/api/branch-context";
import { createBranch, listBranches } from "@/lib/repo/branches";
import { logActivity } from "@/lib/repo/activity";
import { setBranchNameCookie } from "@/lib/api/branch-name-cookie";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  address: z.string().max(200).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
});

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  // Owners see every branch in the tenant; staff see only the ones on their
  // allow-list. The picker also needs to know which branch is currently
  // active (the cookie is HttpOnly so the client can't read it directly), so
  // we ship the resolved active branch in the same payload.
  const [all, current] = await Promise.all([
    listBranches(r.ctx.tenantId),
    resolveActiveBranch(r.ctx),
  ]);
  let filtered = all;
  if (r.ctx.role !== "owner") {
    const allowed = new Set(await getAccessibleBranches(r.ctx));
    filtered = all.filter((b) => allowed.has(b.id));
  }
  const res = NextResponse.json({
    data: filtered,
    currentBranchId: current?.branchId ?? null,
  });
  // Refresh the SSR cookie so subsequent server renders show the right
  // branch heading on first paint (no client-side flicker through the
  // dictionary fallback / tenant slug). See branch-name-cookie.ts.
  setBranchNameCookie(res, current?.branchName ?? null);
  return res;
}

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json(
      { error: "العملية متاحة لصاحب المتجر فقط." },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "بيانات غير صالحة" },
      { status: 400 },
    );
  }

  const { id } = await createBranch(r.ctx.tenantId, parsed.data);

  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "branch.create",
    category: "settings",
    entityType: "branch",
    entityId: id,
    entityLabel: parsed.data.name,
    branchId: id,
  });

  return NextResponse.json({ id });
}
