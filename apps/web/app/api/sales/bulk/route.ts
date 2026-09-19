import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissionAudited } from "@/lib/api/auth-helpers";
import { bulkDeleteSales } from "@/lib/repo/operations";

const schema = z.object({ ids: z.array(z.string().uuid()).min(1) });

export async function DELETE(req: NextRequest) {
  // Voiding sales edits them: `modify_sales`, like DELETE /api/sales/[id]
  // (doc 14 §3.1 C5). Audit mode until PERMISSION_ENFORCE_WRITES=1.
  const r = await requirePermissionAudited("modify_sales");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  await bulkDeleteSales(r.ctx.tenantId, parsed.data.ids);
  return NextResponse.json({ ok: true });
}
