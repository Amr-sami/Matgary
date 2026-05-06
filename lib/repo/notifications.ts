import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { notifications } from "@/lib/db/schema";

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
}

/**
 * Insert a notification. Caller is expected to be already inside a `withTenant`
 * transaction (so RLS sees the tenant), or to wrap this call in one.
 */
export async function createNotification(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  input: CreateNotificationInput,
): Promise<void> {
  await tx.insert(notifications).values({
    tenantId,
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
  });
}

/**
 * Standalone variant for code paths that aren't already in a transaction.
 */
export async function pushNotification(
  tenantId: string,
  input: CreateNotificationInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await createNotification(tx, tenantId, input);
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
}
