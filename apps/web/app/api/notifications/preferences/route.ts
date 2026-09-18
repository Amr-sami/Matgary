import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { isNotificationEventType } from "@/lib/notifications/event-types";
import {
  getNotificationPreferences,
  setNotificationPreference,
} from "@/lib/repo/notifications";

// Per-user notification preferences. Everyone (owner + staff) can read and
// write their OWN row — you don't need admin rights to opt out of your own
// pings. The dispatcher falls back to the code default per role when a row
// is absent, so this endpoint only persists intentional deltas.
//
// Shape (GET):
//   { role: "owner" | "staff",
//     preferences: [{ eventType, inApp, push, email, digestMode, isDefault }] }
// `push` (migration 0049) is the phone push switch per event; it only fires
// when `inApp` is on AND the event is not on the daily digest
// (lib/notifications/dispatch.ts). Its per-(role, event) default is
// DEFAULT_PUSH in lib/repo/notifications.ts — owner `sale.created` is false.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { tenantId, userId } = r.ctx;
  return NextResponse.json(await getNotificationPreferences(tenantId, userId));
}

const bodySchema = z.object({
  eventType: z.string().refine(isNotificationEventType, {
    message: "unknown event type",
  }),
  inApp: z.boolean(),
  // Optional so the web settings page (which predates the column) keeps
  // working: omitted → the stored value is preserved (default on).
  push: z.boolean().optional(),
  email: z.boolean(),
  digestMode: z.enum(["instant", "digest"]),
});

async function write(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { tenantId, userId } = r.ctx;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  const { eventType, inApp, push, email, digestMode } = parsed.data;
  // `eventType` is narrowed by the refine above; z.string().refine keeps the
  // wide type, so the cast is the only way to hand it to the repo.
  const result = await setNotificationPreference(tenantId, userId, {
    eventType: eventType as Parameters<typeof setNotificationPreference>[2]["eventType"],
    inApp,
    push,
    email,
    digestMode,
  });
  return NextResponse.json({ ok: true, ...result });
}

/** Full replace of one event's preference. */
export async function PUT(req: NextRequest) {
  return write(req);
}

/** Same as PUT — kept for the web settings page and older mobile builds. */
export async function PATCH(req: NextRequest) {
  return write(req);
}
