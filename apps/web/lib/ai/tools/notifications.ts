// Agent tools for the Notifications module — READ ONLY.
//
// Why no "send_notification" tool exists:
//   The Storo notification pipeline is event-driven. There is NO stable
//   "arbitrary message → arbitrary recipient" service that applies permission
//   checks, per-user preferences, push-token routing and digest batching.
//   `createNotification` in lib/repo/notifications.ts is INTERNAL and bypasses
//   all of that; wrapping it from the Agent would silently violate user
//   preferences and skip the dispatcher's permission filter.
//
// Side-effect of this choice: when the Owner says "notify Ahmed that the
// inventory count is due", the correct path is preview_create_task (assigned
// to Ahmed). createTaskRepo fires a `task_assigned` notification through the
// existing dispatcher automatically — same push, same preferences, same
// tenant isolation — but via a real domain event instead of a fabricated one.
//
// If the product grows a first-class "custom reminder → user" service, add a
// tool here that wraps it. Do not build a shortcut around the dispatcher.

import {
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
} from "@/lib/repo/notifications";

import type { Tool } from "./types";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ─────────────────────────── list_notifications ────────────────────────── */

export const listNotificationsTool: Tool = {
  name: "list_notifications",
  description:
    "List the caller's recent in-app notifications (up to 30). Returns id, kind, title, body, link, isRead, createdAt. Also returns the unread count. Users only ever see their OWN notifications — tenant + user scope enforced server-side.",
  requiredPermission: "view_dashboard",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const limit = typeof args.limit === "number" ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 30;
    const [rows, unread] = await Promise.all([
      listNotificationsForUser(ctx.tenantId, ctx.userId, limit),
      unreadNotificationCount(ctx.tenantId, ctx.userId),
    ]);
    return {
      ok: true,
      data: {
        unread,
        notifications: rows.map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body,
          link: n.link,
          isRead: n.isRead,
          createdAt: n.createdAt.toISOString(),
        })),
      },
    };
  },
};

/* ─────────────────────── mark_notifications_read ──────────────────────── */

export const markNotificationsReadTool: Tool = {
  name: "mark_notifications_read",
  description:
    "Mark the caller's notifications as read. Pass notification_id to mark one; pass all:true to mark all. Users can only mark their OWN notifications (tenant+user scope enforced). This is a trivial state flip — no confirmation flow is required.",
  requiredPermission: "view_dashboard",
  parameters: {
    type: "object",
    properties: {
      notification_id: { type: "string", description: "uuid of a single notification to mark read." },
      all: { type: "boolean", description: "True → mark ALL unread notifications for this user as read." },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (args.all === true) {
      await markAllNotificationsRead(ctx.tenantId, ctx.userId);
      return { ok: true, data: { scope: "all" } };
    }
    const id = typeof args.notification_id === "string" && UUID_SHAPE.test(args.notification_id)
      ? args.notification_id
      : null;
    if (!id) return { ok: false, error: "INVALID_PARAMS", reason: "Provide notification_id (uuid) or all:true." };
    await markNotificationRead(ctx.tenantId, ctx.userId, id);
    return { ok: true, data: { scope: "single", id } };
  },
};
