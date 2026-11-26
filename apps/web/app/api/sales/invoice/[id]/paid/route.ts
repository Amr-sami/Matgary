import { NextRequest, NextResponse } from "next/server";
import { requirePermissionAudited } from "@/lib/api/auth-helpers";
import { markInvoicePaid } from "@/lib/repo/operations";

const notFound = () => NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Marking an invoice paid edits its sales: `modify_sales`, like
  // /api/sales/[id]/paid and /customers/by-phone/[phone]/mark-all-paid
  // (doc 14 §3.1 C5). Audit mode until PERMISSION_ENFORCE_WRITES=1.
  const r = await requirePermissionAudited("modify_sales");
  if (!r.ok) return r.response;
  const { id } = await params;
  // `invoice_id` is free text (not a uuid), so there is no cast to guard —
  // only a sanity cap. The UPDATE … RETURNING says whether any sale carried
  // that invoice id; before, an unknown id was a silent 200 {ok:true}.
  if (!id || id.length > 80) return notFound();
  if (!(await markInvoicePaid(r.ctx.tenantId, id))) return notFound();
  return NextResponse.json({ ok: true });
}
