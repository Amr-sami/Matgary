// GET /api/whatsapp/conversations?before=<iso>&limit=<n>&unread=1&includeArchived=1
//
// Paginated conversation list for the (future) inbox UI and the
// settings-page summary card.

import { NextResponse, type NextRequest } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { listConversations } from "@/lib/whatsapp/conversations";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");
  const unread = url.searchParams.get("unread") === "1";
  const includeArchived = url.searchParams.get("includeArchived") === "1";

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

  const rows = await listConversations({
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    before,
    limit,
    unreadOnly: unread,
    includeArchived,
  });

  return NextResponse.json({
    ok: true,
    count: rows.length,
    // Cursor for the next page — the caller passes this back as `before`.
    nextBefore: rows.length === limit ? rows[rows.length - 1].lastMessageAt : null,
    conversations: rows.map((r) => ({
      id: r.id,
      phoneNumber: r.phoneNumber,
      displayName: r.merchantLabel || r.displayName || null,
      lastMessageAt: r.lastMessageAt,
      lastMessagePreview: r.lastMessagePreview,
      lastMessageDirection: r.lastMessageDirection,
      unreadCount: r.unreadCount,
      windowExpiresAt: r.windowExpiresAt,
      archivedAt: r.archivedAt,
    })),
  });
}
