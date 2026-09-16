// GET /api/whatsapp/conversations/[id]
//   Single conversation summary, including contact metadata.
// PATCH /api/whatsapp/conversations/[id]
//   Body: { read?: boolean, archived?: boolean }
//   Idempotent. Only owners can archive (mark-read is fine for staff
//   with view_*).

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import {
  getConversationById,
  markRead,
  setArchived,
} from "@/lib/whatsapp/conversations";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const row = await getConversationById(auth.ctx.tenantId, id);
  if (!row) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    conversation: {
      id: row.id,
      phoneNumber: row.phoneNumber,
      displayName: row.merchantLabel || row.displayName || null,
      lastMessageAt: row.lastMessageAt,
      lastMessagePreview: row.lastMessagePreview,
      lastMessageDirection: row.lastMessageDirection,
      unreadCount: row.unreadCount,
      windowExpiresAt: row.windowExpiresAt,
      windowOpen: row.windowExpiresAt
        ? row.windowExpiresAt.getTime() > Date.now()
        : false,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  });
}

const patchSchema = z.object({
  read: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  // Archive is destructive-ish (hides from default list). Owner-only.
  if (parsed.data.archived !== undefined && auth.ctx.role !== "owner") {
    return NextResponse.json(
      { ok: false, error: "Owner role required to archive" },
      { status: 403 },
    );
  }

  if (parsed.data.read) {
    await markRead(auth.ctx.tenantId, id);
  }
  if (parsed.data.archived !== undefined) {
    await setArchived(auth.ctx.tenantId, id, parsed.data.archived);
  }

  return NextResponse.json({ ok: true });
}
