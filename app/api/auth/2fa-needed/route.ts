import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { rateLimit } from "@/lib/ratelimit";

const schema = z.object({
  email: z.string().min(3).max(200),
});

// POST /api/auth/2fa-needed — the login form calls this BEFORE the
// credentials POST to decide whether to show the TOTP input. We do this here
// (instead of relying on Auth.js's custom-error-code propagation, which is
// flaky in v5 beta) because the form needs a reliable signal.
//
// The endpoint leaks "this email has 2FA enabled" to anyone with a working
// IP — same exposure shape as the forgot-password endpoint. Mitigated by:
//   - rate-limit per IP (30 / minute) so it can't be used to enumerate.
//   - always return { needsTotp: false } when the limiter trips so timing
//     and response shape can't be distinguished from a "no" answer.
//   - no password handling here, so brute-forcing via this endpoint just
//     wastes the attacker's quota without learning anything new.

const RL_LIMIT = 30;
const RL_WINDOW_SEC = 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ needsTotp: false });
  }
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip")?.trim() ??
    "unknown";
  const rl = await rateLimit("auth.2fa_needed", ip, {
    limit: RL_LIMIT,
    windowSec: RL_WINDOW_SEC,
  });
  if (!rl.ok) {
    return NextResponse.json({ needsTotp: false });
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db
    .select({ totpEnabledAt: users.totpEnabledAt })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return NextResponse.json({ needsTotp: !!user?.totpEnabledAt });
}
