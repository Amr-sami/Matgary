// Internal handshake between /api/admin/tenants/[id]/impersonate and the
// NextAuth credentials provider. The admin POST returns the URL to this
// endpoint; the browser follows the redirect via a hard navigation so the
// NextAuth cookie set by signIn() lands on the tenant origin before the
// /dashboard render.

import { NextRequest, NextResponse } from "next/server";
import { signIn } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "MISSING_TOKEN" }, { status: 400 });
  }

  try {
    // signIn() with redirect:false returns the URL to navigate to after a
    // successful sign-in. The credentials provider's authorize() picks up
    // the impersonationToken field, validates it via consumeImpersonationToken,
    // and the JWT callback embeds the impersonation claims.
    await signIn("credentials", {
      impersonationToken: token,
      redirect: false,
      // Don't surface NextAuth's CSRF protection — the token IS the proof.
      // Internal-only flow.
    });
    // signIn sets the cookie on the response. We just need to redirect.
    return NextResponse.redirect(new URL("/", req.url));
  } catch (err) {
    // The credentials provider returns null when the token is bad / expired
    // / already consumed; NextAuth surfaces that as a CredentialsSignin
    // error. Map it to a 400 here so the client can react cleanly.
    return NextResponse.json(
      {
        error: "SIGNIN_FAILED",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }
}
