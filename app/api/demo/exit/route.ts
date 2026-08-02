// Drop the visitor's ephemeral demo tenant AND clear the Auth.js session
// cookie so the browser can't navigate back into the now-deleted tenant
// with a stale JWT. The DemoBanner posts here, then hard-navigates to "/";
// this endpoint does both halves in one round-trip so there's no race
// where the cookie outlives the tenant.

// Drop the visitor's ephemeral demo tenant and bounce to /ar/login in one
// round-trip. The browser does a full navigation here, which kills every
// in-flight XHR (SessionProvider polling, RSC fetches), so there's no
// race that could re-rotate the cookie back into existence.
//
// Demo is not a real auth surface — we don't owe the visitor a CSRF token
// or a NextAuth-managed sign-out. Delete the tenant, expire the cookies,
// redirect. Done.

import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { deleteDemoClone } from "@/lib/demo/clone-tenant";

const AUTH_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

async function exitDemo(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (session?.user?.isDemo && session.user.tenantId) {
    try {
      await deleteDemoClone(session.user.tenantId);
    } catch (err) {
      console.warn("[demo/exit] delete failed:", err);
    }
  }

  const locale = req.headers.get("x-locale") === "en" ? "en" : "ar";
  const redirect = new URL(`/${locale}/login`, req.url);
  const res = NextResponse.redirect(redirect);
  for (const name of AUTH_COOKIE_NAMES) {
    res.cookies.set({
      name,
      value: "",
      path: "/",
      maxAge: 0,
      ...(name.startsWith("__Secure-")
        ? { secure: true, sameSite: "lax" as const, httpOnly: true }
        : {}),
    });
  }
  return res;
}

// GET so the DemoBanner can just window.location.href the URL — no fetch,
// no React state, no transition.
export async function GET(req: NextRequest) {
  return exitDemo(req);
}

// POST kept for any existing form callers.
export async function POST(req: NextRequest) {
  return exitDemo(req);
}
