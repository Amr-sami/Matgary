// POST /api/admin/tenants/[id]/reset-owner-password
//
// Super-admin only. Generates a one-shot temporary password, resets the
// owner's `password_hash`, forces `must_change_password = true`, bumps
// `token_version` (every existing JWT becomes invalid on next request),
// deletes every NextAuth session row AND every native auth_devices row
// so the owner is signed out EVERYWHERE, and audits the action.
//
// The temp password is returned in the response body ONCE — the admin UI
// shows it in a modal with a "copy" affordance and never persists it on
// the client. Nothing on this path writes the plaintext password or its
// hash to the audit log.
//
// Confirmation: the UI requires two explicit steps before firing POST.

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import {
  TenantActionError,
  resetOwnerPassword,
} from "@/lib/admin/tenant-actions";
import { clientIpOrNull } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("tenant.reset_owner_password");
  if (!r.ok) return r.response;

  const { id } = await params;
  try {
    const result = await resetOwnerPassword(r.session.adminId, id, {
      ip: clientIpOrNull(req),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({
      ok: true,
      temporaryPassword: result.temporaryPassword,
      ownerEmail: result.ownerEmail,
    });
  } catch (err) {
    if (err instanceof TenantActionError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
