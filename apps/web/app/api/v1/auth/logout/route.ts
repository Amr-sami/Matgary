import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { hashRefreshToken } from "@/lib/api/native-token";

// Sign out ONE device.
//
// No session is required: possession of the refresh token is the authority to
// destroy it, and demanding a valid access token would make logout impossible
// in the case that needs it most — the access token has expired and the user
// wants out.
//
// Deliberately idempotent and deliberately blind. An unknown token, an
// already-revoked token and a successful revoke all return the same 200, so a
// client retrying over a flaky connection is never stuck in a "logout failed"
// loop, and nobody can use this endpoint as an oracle for which token hashes
// exist.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  refreshToken: z.string().min(20).max(500),
});

function clientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() ?? "unknown";
}

export async function POST(req: Request) {
  const h = await headers();

  // Loose enough that honest retries never trip it, tight enough that the
  // endpoint cannot be driven as a bulk revocation probe.
  const limited = await rateLimit("auth.logout.ip", clientIp(h), {
    limit: 60,
    windowSec: 300,
  });
  if (!limited.ok) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    // A malformed request is a client bug, not a missing token — say so. This
    // leaks nothing: it is decided before any lookup happens.
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  // `revoked_at IS NULL` keeps a retry from overwriting the original reason
  // and timestamp of an earlier revoke (e.g. a 'token_reuse' sweep).
  await db.execute(sql`
    UPDATE auth_devices
       SET revoked_at = now(), revoked_reason = 'logout'
     WHERE refresh_token_hash = ${hashRefreshToken(body.refreshToken)}
       AND revoked_at IS NULL
  `);

  return NextResponse.json({ ok: true });
}
