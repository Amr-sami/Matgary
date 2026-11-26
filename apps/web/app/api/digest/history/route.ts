import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { listRecentRuns } from "@/lib/repo/digest-runs";

export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_digest_settings");
  if (!r.ok) return r.response;
  const branchId = req.nextUrl.searchParams.get("branchId");
  const rows = await listRecentRuns(r.ctx.tenantId, branchId, 100);
  return NextResponse.json({
    data: rows.map((row) => ({
      id: row.id,
      branchId: row.branchId,
      businessDate: row.businessDate,
      recipientPhone: row.recipientPhone,
      recipientEmail: row.recipientEmail,
      channel: row.channel,
      status: row.status,
      error: row.error,
      messageText: row.messageText,
      enqueuedAt: row.enqueuedAt,
      sentAt: row.sentAt,
    })),
  });
}
