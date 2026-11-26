import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissionAudited } from "@/lib/api/auth-helpers";
import { markSalePaid } from "@/lib/repo/operations";

// C20 class — a non-uuid id made Postgres refuse the cast (500) and an unknown
// uuid was a silent 200 {ok:true}. markSalePaid reports whether a row matched.
const idSchema = z.string().uuid();
const notFound = () => NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Marking a sale paid edits it: `modify_sales`, like PATCH /api/sales/[id]
  // and /customers/by-phone/[phone]/mark-all-paid (doc 14 §3.1 C5).
  const r = await requirePermissionAudited("modify_sales");
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  if (!(await markSalePaid(r.ctx.tenantId, id))) return notFound();
  return NextResponse.json({ ok: true });
}
