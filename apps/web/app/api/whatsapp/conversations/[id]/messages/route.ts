// GET /api/whatsapp/conversations/[id]/messages?before=<iso>&limit=<n>
//
// Reverse-chronological page of messages in a conversation. Cursor on
// created_at. Used by the inbox thread view (Phase 5+).

import { NextResponse, type NextRequest } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { listMessages } from "@/lib/whatsapp/conversations";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const url = new URL(req.url);
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");

  let before: Date | undefined;
  if (beforeRaw) {
    const d = new Date(beforeRaw);
    if (!Number.isFinite(d.valueOf())) {
      return NextResponse.json(
        { ok: false, error: "Invalid `before` cursor" },
        { status: 400 },
      );
    }
    before = d;
  }
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return NextResponse.json(
      { ok: false, error: "limit must be between 1 and 200" },
      { status: 400 },
    );
  }

  const rows = await listMessages({
    tenantId: auth.ctx.tenantId,
    conversationId: id,
    before,
    limit,
  });

  return NextResponse.json({
    ok: true,
    count: rows.length,
    nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null,
    messages: rows.map((m) => ({
      id: m.id,
      direction: m.direction,
      metaMessageId: m.metaMessageId,
      clientMessageId: m.clientMessageId,
      messageType: m.messageType,
      textBody: m.textBody,
      mediaId: m.mediaId,
      mediaMimeType: m.mediaMimeType,
      mediaFilename: m.mediaFilename,
      status: m.status,
      sentAt: m.sentAt,
      deliveredAt: m.deliveredAt,
      readAt: m.readAt,
      failedAt: m.failedAt,
      failureReason: m.failureReason,
      receivedAt: m.receivedAt,
      createdAt: m.createdAt,
    })),
  });
}
