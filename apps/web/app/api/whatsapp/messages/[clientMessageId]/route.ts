// GET /api/whatsapp/messages/[clientMessageId]
//
// Lightweight status read for callers that enqueued an outbound message
// and want to know what happened. Returns the wa_messages row keyed by
// the client-issued UUID. Tenant-scoped — RLS forces single-tenant
// reads even if a clientMessageId leaks.

import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { getMessageByClientId } from "@/lib/whatsapp/messages";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ clientMessageId: string }> },
) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;

  const { clientMessageId } = await ctx.params;
  if (!clientMessageId || clientMessageId.length > 80) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const row = await getMessageByClientId(auth.ctx.tenantId, clientMessageId);
  if (!row) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    message: {
      id: row.id,
      clientMessageId: row.clientMessageId,
      metaMessageId: row.metaMessageId,
      direction: row.direction,
      contactPhoneNumber: row.contactPhoneNumber,
      messageType: row.messageType,
      textBody: row.textBody,
      status: row.status,
      sentAt: row.sentAt,
      deliveredAt: row.deliveredAt,
      readAt: row.readAt,
      failedAt: row.failedAt,
      failureReason: row.failureReason,
      failureCode: row.failureCode,
      conversationCategory: row.conversationCategory,
      pricingCategory: row.pricingCategory,
      pricingBillable: row.pricingBillable,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  });
}
