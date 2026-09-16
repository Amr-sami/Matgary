import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { listAuditRows } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const r = await requirePermission("audit.read");
  if (!r.ok) return r.response;
  const sp = req.nextUrl.searchParams;
  const since = sp.get("since");
  const until = sp.get("until");
  const limit = sp.get("limit");
  const q = sp.get("q");
  const result = await listAuditRows({
    actorAdminId: sp.get("actorAdminId") || undefined,
    actionPrefix: sp.get("actionPrefix") || undefined,
    targetKind: sp.get("targetKind") || undefined,
    targetId: sp.get("targetId") || undefined,
    // Free-text only fires when the client sends at least 3 chars — the
    // GIN index is still lookup-friendly below that but the cost ratio
    // gets unfavourable, so we require it client-side AND defend here.
    q: q && q.length >= 3 ? q : undefined,
    since: since ? new Date(since) : undefined,
    until: until ? new Date(until) : undefined,
    cursor: sp.get("cursor") || undefined,
    limit: limit ? Number(limit) : undefined,
  });
  return NextResponse.json(result);
}
