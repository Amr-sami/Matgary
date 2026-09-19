import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissionAudited } from "@/lib/api/auth-helpers";
import { deleteExpense } from "@/lib/repo/operations";

// C20 class — a non-uuid id made Postgres refuse the `id = $2` cast (500) and
// an unknown uuid was a silent `200 {ok:true}`. The uuid gate answers the
// first without a query; deleteExpense reports whether a row went.
const idSchema = z.string().uuid();
const notFound = () => NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Same gate as POST /api/expenses (manage_expenses), audit mode until
  // PERMISSION_ENFORCE_WRITES=1 (doc 14 §3.1 C5). The row is addressed by
  // (tenant, id), so the branch-less audited helper is the right one.
  const r = await requirePermissionAudited("manage_expenses");
  if (!r.ok) return r.response;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  if (!(await deleteExpense(r.ctx.tenantId, id))) return notFound();
  return NextResponse.json({ ok: true });
}
