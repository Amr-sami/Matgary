// Notification Center — user preference + tenant override CRUD.
//
// GET  → current resolved preferences for the caller (user row ∪ tenant override
//        ∪ system default) per event.
// PATCH → update ONE event. Scope = 'user' writes notification_preferences;
//        scope = 'tenant' writes tenant_notification_overrides. Tenant-scope
//        edits are owner-only (or any user with manage_settings).
//
// Every PATCH emits an activity_logs row so the owner can see who changed
// what.

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  notificationPreferences,
  tenantNotificationOverrides,
} from "@/lib/db/schema";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  DEFAULT_EVENT_PREFERENCE,
  isNotificationEventType,
  type NotificationEventType,
  type TenantMemberRole,
} from "@/lib/notifications/event-types";
import { DEFAULT_PUSH } from "@/lib/repo/notifications";
import { logActivity } from "@/lib/repo/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  eventType: z.string().min(3).max(80),
  scope: z.enum(["user", "tenant"]),
  // user-scope fields
  inApp: z.boolean().optional(),
  push: z.boolean().optional(),
  email: z.boolean().optional(),
  digestMode: z.enum(["instant", "digest"]).optional(),
  // tenant-scope field
  enabled: z.boolean().optional(),
});

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  const [userRows, tenantRows] = await Promise.all([
    db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.tenantId, r.ctx.tenantId),
          eq(notificationPreferences.userId, r.ctx.userId),
        ),
      ),
    db
      .select()
      .from(tenantNotificationOverrides)
      .where(eq(tenantNotificationOverrides.tenantId, r.ctx.tenantId)),
  ]);

  return NextResponse.json({
    tenantId: r.ctx.tenantId,
    userId: r.ctx.userId,
    userPreferences: userRows.map((row) => ({
      eventType: row.eventType,
      inApp: row.inApp,
      push: row.push,
      email: row.email,
      digestMode: row.digestMode,
    })),
    tenantOverrides: tenantRows.map((row) => ({
      eventType: row.eventType,
      enabled: row.enabled,
      updatedByUserId: row.updatedByUserId,
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function PATCH(req: Request) {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_BODY", issue: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }
  if (!isNotificationEventType(parsed.data.eventType)) {
    return NextResponse.json({ error: "UNKNOWN_EVENT_TYPE" }, { status: 400 });
  }
  const eventType = parsed.data.eventType as NotificationEventType;

  // Tenant-scope writes require manage_settings (or owner).
  if (parsed.data.scope === "tenant") {
    const canManage =
      r.ctx.role === "owner" || r.ctx.permissions.includes("view_settings");
    if (!canManage) {
      return NextResponse.json(
        { error: "FORBIDDEN", reason: "view_settings required" },
        { status: 403 },
      );
    }
    if (parsed.data.enabled === undefined) {
      return NextResponse.json(
        { error: "INVALID_BODY", reason: "enabled required for tenant scope" },
        { status: 400 },
      );
    }

    // Read current state for the audit trail.
    const [existing] = await db
      .select({ enabled: tenantNotificationOverrides.enabled })
      .from(tenantNotificationOverrides)
      .where(
        and(
          eq(tenantNotificationOverrides.tenantId, r.ctx.tenantId),
          eq(tenantNotificationOverrides.eventType, eventType),
        ),
      )
      .limit(1);

    // UPSERT the override row.
    if (existing) {
      await db
        .update(tenantNotificationOverrides)
        .set({
          enabled: parsed.data.enabled,
          updatedByUserId: r.ctx.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tenantNotificationOverrides.tenantId, r.ctx.tenantId),
            eq(tenantNotificationOverrides.eventType, eventType),
          ),
        );
    } else {
      await db.insert(tenantNotificationOverrides).values({
        tenantId: r.ctx.tenantId,
        eventType,
        enabled: parsed.data.enabled,
        updatedByUserId: r.ctx.userId,
      });
    }

    await logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "notification.preference.changed",
      category: "settings",
      entityType: "tenant_notification_override",
      // activity_logs.entity_id is uuid; the event name moves into metadata.
      entityId: r.ctx.tenantId,
      entityLabel: eventType,
      metadata: {
        scope: "tenant",
        eventType,
        before: existing ? { enabled: existing.enabled } : null,
        after: { enabled: parsed.data.enabled },
      },
    });

    return NextResponse.json({ ok: true });
  }

  // User-scope write — anyone can edit their own channel preferences.
  const role: TenantMemberRole = r.ctx.role === "owner" ? "owner" : "staff";
  const systemDefault = DEFAULT_EVENT_PREFERENCE[role][eventType];
  const defaultPush = (DEFAULT_PUSH[role] ?? DEFAULT_PUSH.staff)[eventType];

  const [existing] = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.tenantId, r.ctx.tenantId),
        eq(notificationPreferences.userId, r.ctx.userId),
        eq(notificationPreferences.eventType, eventType),
      ),
    )
    .limit(1);

  // Compose the new row — unspecified channels fall back to the existing row
  // if any, else the system default. This lets the UI toggle one channel at
  // a time without round-tripping the whole shape.
  const next = {
    inApp: parsed.data.inApp ?? existing?.inApp ?? systemDefault.inApp,
    push: parsed.data.push ?? existing?.push ?? defaultPush,
    email: parsed.data.email ?? existing?.email ?? systemDefault.email,
    digestMode:
      parsed.data.digestMode ?? (existing?.digestMode === "digest" ? "digest" : "instant"),
  };

  if (existing) {
    await db
      .update(notificationPreferences)
      .set({
        inApp: next.inApp,
        push: next.push,
        email: next.email,
        digestMode: next.digestMode,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(notificationPreferences.tenantId, r.ctx.tenantId),
          eq(notificationPreferences.userId, r.ctx.userId),
          eq(notificationPreferences.eventType, eventType),
        ),
      );
  } else {
    await db.insert(notificationPreferences).values({
      tenantId: r.ctx.tenantId,
      userId: r.ctx.userId,
      eventType,
      inApp: next.inApp,
      push: next.push,
      email: next.email,
      digestMode: next.digestMode,
    });
  }

  await logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "notification.preference.changed",
    category: "settings",
    entityType: "notification_preference",
    entityId: r.ctx.userId,
    entityLabel: eventType,
    metadata: {
      scope: "user",
      eventType,
      before: existing
        ? {
            inApp: existing.inApp,
            push: existing.push,
            email: existing.email,
            digestMode: existing.digestMode,
          }
        : null,
      after: next,
    },
  });

  return NextResponse.json({ ok: true });
}
