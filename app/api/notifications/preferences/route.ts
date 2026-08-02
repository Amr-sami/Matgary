import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@/lib/db";
import { notificationPreferences, tenantMembers } from "@/lib/db/schema";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  DEFAULT_EVENT_PREFERENCE,
  NOTIFICATION_EVENT_TYPES,
  isNotificationEventType,
  resolvePreference,
  type NotificationEventType,
  type TenantMemberRole,
} from "@/lib/notifications/event-types";

// Per-user notification preferences. Everyone (owner + staff) can read and
// write their OWN row — you don't need admin rights to opt out of your own
// pings. The dispatcher falls back to the code default per role when a row
// is absent, so this endpoint only persists intentional deltas.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row {
  eventType: NotificationEventType;
  inApp: boolean;
  email: boolean;
  digestMode: "instant" | "digest";
  isDefault: boolean;
}

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { tenantId, userId } = r.ctx;

  const [member, stored] = await withTenant(tenantId, async (tx) => {
    const memberRow = await tx
      .select({ role: tenantMembers.role })
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          eq(tenantMembers.userId, userId),
        ),
      )
      .limit(1);
    const storedRows = await tx
      .select({
        eventType: notificationPreferences.eventType,
        inApp: notificationPreferences.inApp,
        email: notificationPreferences.email,
        digestMode: notificationPreferences.digestMode,
      })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.tenantId, tenantId),
          eq(notificationPreferences.userId, userId),
        ),
      );
    return [memberRow[0] ?? null, storedRows] as const;
  });

  const role = (member?.role === "owner" ? "owner" : "staff") as TenantMemberRole;
  const storedByEvent = new Map(stored.map((s) => [s.eventType, s]));

  const preferences: Row[] = NOTIFICATION_EVENT_TYPES.map((eventType) => {
    const s = storedByEvent.get(eventType);
    const resolved = resolvePreference(
      role,
      eventType,
      s
        ? {
            inApp: s.inApp,
            email: s.email,
            digestMode: s.digestMode === "digest" ? "digest" : "instant",
          }
        : null,
    );
    return {
      eventType,
      inApp: resolved.inApp,
      email: resolved.email,
      digestMode: resolved.digestMode,
      isDefault: !s,
    };
  });

  return NextResponse.json({ role, preferences });
}

const patchSchema = z.object({
  eventType: z.string().refine(isNotificationEventType, {
    message: "unknown event type",
  }),
  inApp: z.boolean(),
  email: z.boolean(),
  digestMode: z.enum(["instant", "digest"]),
});

export async function PATCH(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { tenantId, userId } = r.ctx;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  const { eventType, inApp, email, digestMode } = parsed.data;

  // Compare against the code default for this user's role; if the incoming
  // shape matches the default we DELETE the row (keeps the table sparse
  // and makes "reset to default" a natural no-op).
  const [member] = await withTenant(tenantId, async (tx) =>
    tx
      .select({ role: tenantMembers.role })
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          eq(tenantMembers.userId, userId),
        ),
      )
      .limit(1),
  );
  const role = (member?.role === "owner" ? "owner" : "staff") as TenantMemberRole;
  const def = DEFAULT_EVENT_PREFERENCE[role][eventType as NotificationEventType];
  const matchesDefault =
    def.inApp === inApp && def.email === email && def.digestMode === digestMode;

  await withTenant(tenantId, async (tx) => {
    if (matchesDefault) {
      await tx
        .delete(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.tenantId, tenantId),
            eq(notificationPreferences.userId, userId),
            eq(notificationPreferences.eventType, eventType),
          ),
        );
      return;
    }
    await tx
      .insert(notificationPreferences)
      .values({
        tenantId,
        userId,
        eventType,
        inApp,
        email,
        digestMode,
      })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.tenantId,
          notificationPreferences.userId,
          notificationPreferences.eventType,
        ],
        set: {
          inApp,
          email,
          digestMode,
          updatedAt: sql`now()`,
        },
      });
  });

  return NextResponse.json({ ok: true });
}
