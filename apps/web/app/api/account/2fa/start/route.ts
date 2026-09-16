import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { auth } from "@/lib/auth";
import { startEnrollment } from "@/lib/repo/account-security";

// POST /api/account/2fa/start
// Returns a fresh TOTP secret + otpauth:// URI for the client to render
// (manual paste or QR). NOT committed to the DB — the matching POST /enable
// is what actually writes. Owner-only in v1.
export async function POST() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await auth();
  const email = session?.user?.email ?? "user";
  const preview = await startEnrollment(email);
  return NextResponse.json(preview);
}
