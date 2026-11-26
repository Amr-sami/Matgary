import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { isTotpEnabled } from "@/lib/repo/account-security";

// GET /api/account/2fa-status — tiny boolean lookup used by the
// /account/security page to render the right state. Owner-or-self only.
export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const enabled = await isTotpEnabled(r.ctx.userId);
  return NextResponse.json({ enabled });
}
