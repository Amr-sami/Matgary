import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { rateLimit } from "@/lib/ratelimit";

// Public endpoint: returns whether an email is currently free or already
// registered. Used by the signup form for live availability feedback so
// the user finds out at step 1 (email + password) instead of step 2
// (after they've also filled in store name + handle). Mirrors the
// /api/account/store-handle/check shape.
//
// Same exposure shape as /api/auth/2fa-needed — leaks "this email exists"
// to anyone with a working IP. Mitigations:
//   - 60 reqs/minute/IP rate-limit (one legit user submits ~5 in a session).
//   - Limit-trip returns the same {available:false,reason:"invalid"} shape
//     a malformed address would, so the attacker can't distinguish a real
//     deny from a syntax fail.

const RL_LIMIT = 60;
const RL_WINDOW_SEC = 60;

async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip")?.trim() ??
    "unknown"
  );
}

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!raw || raw.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    return NextResponse.json({ available: false, reason: "invalid" });
  }
  const ip = await clientIp();
  const rl = await rateLimit("auth.email_check", ip, {
    limit: RL_LIMIT,
    windowSec: RL_WINDOW_SEC,
  });
  if (!rl.ok) {
    return NextResponse.json({ available: false, reason: "invalid" });
  }
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, raw))
    .limit(1);
  return NextResponse.json({ available: !row });
}
