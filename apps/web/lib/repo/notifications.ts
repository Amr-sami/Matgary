import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  notificationPreferences,
  notifications,
  tenantMembers,
} from "@/lib/db/schema";
import {
  DEFAULT_EVENT_PREFERENCE,
  NOTIFICATION_EVENT_TYPES,
  resolvePreference,
  type DigestMode,
  type NotificationEventType,
  type TenantMemberRole,
} from "@/lib/notifications/event-types";
import { publishUserNotificationEvent } from "@/lib/notifications/events";
import { notifyUserDevices, routeForNotification } from "@/lib/push/notify";

export type NotificationKind =
  | "low_stock"
  | "task_assigned"
  | "task_started"
  | "task_done"
  | "task_updated"
  | "leave_submitted"
  | "leave_decided"
  | "info";

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: Date;
}

export async function listNotificationsForUser(
  tenantId: string,
  userId: string,
  limit = 30,
): Promise<NotificationDto[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as NotificationKind,
      title: r.title,
      body: r.body,
      link: r.link,
      isRead: r.isRead,
      createdAt: r.createdAt,
    }));
  });
}

export async function unreadNotificationCount(
  tenantId: string,
  userId: string,
): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
        ),
      );
    return count;
  });
}

export interface CreateNotificationInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Also push to the recipient's phones. Default true. The dispatcher passes
   *  false for digest-mode events (`sale.created` for an owner — §8.3: the
   *  bell shows it, the phone follows the daily-digest logic instead). */
  push?: boolean;
}

/**
 * Insert a notification. Caller is expected to be already inside a `withTenant`
 * transaction (so RLS sees the tenant), or to wrap this call in one.
 */
export async function createNotification(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  /** Branch this notification is associated with. Pass null for tenant-wide
   *  system notifications (billing, account, etc.). */
  branchId: string | null,
  input: CreateNotificationInput,
): Promise<void> {
  const [row] = await tx
    .insert(notifications)
    .values({
      tenantId,
      branchId,
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })
    .returning({ id: notifications.id });
  // Fire-and-forget pub/sub poke. If the surrounding tx later rolls back,
  // the SSE consumer just refetches and finds nothing new — harmless.
  void publishUserNotificationEvent(input.userId);
  // Fire-and-forget Expo push to the recipient's phones. NOT harmless on
  // rollback — a push for a row that never committed lands on a 404 — so
  // notifyUserDevices waits until this row is visible from another
  // connection before it sends, and gives up quietly if it never is.
  if (input.push === false) return;
  void notifyUserDevices(tenantId, input.userId, {
    title: input.title,
    body: input.body ?? null,
    notificationId: row?.id ?? null,
    data: {
      type: input.kind,
      route: routeForNotification(input.kind, input.link),
      id: row?.id ?? null,
      link: input.link ?? null,
      tenantId,
      branchId,
    },
  });
}

/**
 * Standalone variant for code paths that aren't already in a transaction.
 */
export async function pushNotification(
  tenantId: string,
  branchId: string | null,
  input: CreateNotificationInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await createNotification(tx, tenantId, branchId, input);
  });
}

export async function markNotificationRead(
  tenantId: string,
  userId: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          eq(notifications.id, id),
        ),
      );
  });
  void publishUserNotificationEvent(userId);
}

export async function markAllNotificationsRead(
  tenantId: string,
  userId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
        ),
      );
  });
  void publishUserNotificationEvent(userId);
}

export async function unreadCountByKind(
  tenantId: string,
  userId: string,
  kinds: NotificationKind[],
): Promise<number> {
  if (kinds.length === 0) return 0;
  return withTenant(tenantId, async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
          inArray(notifications.kind, kinds),
        ),
      );
    return count;
  });
}

export async function markReadByKind(
  tenantId: string,
  userId: string,
  kinds: NotificationKind[],
): Promise<void> {
  if (kinds.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
          inArray(notifications.kind, kinds),
        ),
      );
  });
  void publishUserNotificationEvent(userId);
}

// ---------------------------------------------------------------------------
// Per-event notification preferences (GET/PUT /api/notifications/preferences).
//
// A `notification_preferences` row exists only when the user has moved at
// least one channel away from the code default for their role; the
// dispatcher (lib/notifications/dispatch.ts) treats a missing row as "use
// DEFAULT_EVENT_PREFERENCE". `push` (migration 0049) is not yet a field of
// that matrix, so its per-(role, event) default lives here (doc 06 §8.3) and
// counts towards "matches default". It agrees with what the dispatcher
// actually does for a missing row — `pref.inApp && pref.digestMode !==
// "digest" && (stored.push ?? true)` — so the GET never reports push ON for
// an event the server would never buzz the phone about. TODO: fold `push`
// into EventPreference / DEFAULT_EVENT_PREFERENCE in event-types.ts and
// gate dispatch.ts on the stored flag alone (both outside this feature).
// ---------------------------------------------------------------------------

/** Per-(role, event) push default — doc 06 §8.3. Owner: every event except
 *  `sale.created` (highest volume; it is on the daily digest). Staff: only
 *  the events they see in-app by default. */
export const DEFAULT_PUSH: Record<
  TenantMemberRole,
  Record<NotificationEventType, boolean>
> = {
  owner: {
    "sale.created": false,
    "purchase.received": true,
    "inventory.low_stock": true,
    "payment.deferred_settled": true,
    "leave.requested": true,
  },
  staff: {
    "sale.created": false,
    "purchase.received": true,
    "inventory.low_stock": true,
    "payment.deferred_settled": false,
    "leave.requested": false,
  },
};

export interface EventPreferenceDto {
  eventType: NotificationEventType;
  inApp: boolean;
  /** Phone push for this event; only fires when `inApp` is on and
   *  `digestMode` is "instant" (dispatch.ts). */
  push: boolean;
  email: boolean;
  digestMode: DigestMode;
  /** True when no row is stored — every channel is the role default. */
  isDefault: boolean;
}

export interface NotificationPreferencesDto {
  role: TenantMemberRole;
  preferences: EventPreferenceDto[];
}

export interface SetEventPreferenceInput {
  eventType: NotificationEventType;
  inApp: boolean;
  /** Omitted (a web client that predates the column) keeps the stored value. */
  push?: boolean;
  email: boolean;
  digestMode: DigestMode;
}

async function memberRole(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  userId: string,
): Promise<TenantMemberRole> {
  const [member] = await tx
    .select({ role: tenantMembers.role })
    .from(tenantMembers)
    .where(
      and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)),
    )
    .limit(1);
  return member?.role === "owner" ? "owner" : "staff";
}

export async function getNotificationPreferences(
  tenantId: string,
  userId: string,
): Promise<NotificationPreferencesDto> {
  const [role, stored] = await withTenant(tenantId, async (tx) => {
    const r = await memberRole(tx, tenantId, userId);
    const rows = await tx
      .select({
        eventType: notificationPreferences.eventType,
        inApp: notificationPreferences.inApp,
        push: notificationPreferences.push,
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
    return [r, rows] as const;
  });

  const storedByEvent = new Map(stored.map((s) => [s.eventType, s]));
  const preferences = NOTIFICATION_EVENT_TYPES.map((eventType): EventPreferenceDto => {
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
      push: s?.push ?? DEFAULT_PUSH[role][eventType],
      email: resolved.email,
      digestMode: resolved.digestMode,
      isDefault: !s,
    };
  });

  return { role, preferences };
}

/**
 * Upsert one event's preference. When every channel equals the role default
 * the row is DELETED instead — the table stays sparse and "reset to default"
 * is a natural no-op (the GET then reports `isDefault: true` again).
 */
export async function setNotificationPreference(
  tenantId: string,
  userId: string,
  input: SetEventPreferenceInput,
): Promise<{ isDefault: boolean }> {
  const { eventType, inApp, email, digestMode } = input;
  return withTenant(tenantId, async (tx) => {
    const role = await memberRole(tx, tenantId, userId);
    const where = and(
      eq(notificationPreferences.tenantId, tenantId),
      eq(notificationPreferences.userId, userId),
      eq(notificationPreferences.eventType, eventType),
    );

    let push = input.push;
    if (push === undefined) {
      const [existing] = await tx
        .select({ push: notificationPreferences.push })
        .from(notificationPreferences)
        .where(where)
        .limit(1);
      push = existing?.push ?? DEFAULT_PUSH[role][eventType];
    }

    const def = DEFAULT_EVENT_PREFERENCE[role][eventType];
    const matchesDefault =
      def.inApp === inApp &&
      def.email === email &&
      def.digestMode === digestMode &&
      push === DEFAULT_PUSH[role][eventType];

    if (matchesDefault) {
      await tx.delete(notificationPreferences).where(where);
      return { isDefault: true };
    }

    await tx
      .insert(notificationPreferences)
      .values({ tenantId, userId, eventType, inApp, push, email, digestMode })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.tenantId,
          notificationPreferences.userId,
          notificationPreferences.eventType,
        ],
        set: { inApp, push, email, digestMode, updatedAt: sql`now()` },
      });
    return { isDefault: false };
  });
}
