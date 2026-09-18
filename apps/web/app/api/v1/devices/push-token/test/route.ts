import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireTenant } from "@/lib/api/auth-helpers";
import { notifyUserDevices } from "@/lib/push/notify";
import { rateLimit } from "@/lib/ratelimit";

// Send a test push to every active device of the caller. Device QA: register,
// hit this, watch the banner. The response echoes Expo's tickets so a dead
// token is visible without a database peek — and it is pruned as a side
// effect exactly as a real fan-out would prune it.
//
// Title/body are built here, in the caller's own locale (§8.5) — the client
// never supplies push copy. Rate-limited per user: every call is a real Expo
// round-trip and a real banner on the phone.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COPY = {
  ar: { title: "TheStoro", body: "إشعار تجريبي — الإشعارات شغّالة على هذا الجهاز" },
  en: { title: "TheStoro", body: "Test notification — push is working on this device" },
} as const;

export async function POST() {
  const auth = await requireTenant();
  if (!auth.ok) return auth.response;
  const { tenantId, userId } = auth.ctx;

  const limited = await rateLimit("push.test.user", userId, { limit: 5, windowSec: 60 });
  if (!limited.ok) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  const [u] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const copy = COPY[u?.locale === "en" ? "en" : "ar"];

  const result = await notifyUserDevices(tenantId, userId, {
    title: copy.title,
    body: copy.body,
    data: { type: "test", route: "/notifications", id: null },
  });

  return NextResponse.json({
    ok: true,
    status: result.status,
    sent: result.outcomes.filter((o) => o.ticket.status === "ok").length,
    failed: result.outcomes.filter((o) => o.ticket.status !== "ok").length,
    disabled: result.disabled.length,
    tickets: result.outcomes.map((o) => ({
      to: o.to,
      status: o.ticket.status,
      error: o.ticket.status === "error" ? o.ticket.details?.error ?? o.ticket.message ?? null : null,
    })),
  });
}
