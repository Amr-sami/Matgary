// Registry of the events the notification system knows about + per-role
// defaults. A row in `notification_preferences` overrides these; when no row
// exists the dispatcher applies the code default for the recipient's role.
//
// Everything the settings UI, the dispatcher, and the email templates read
// funnels through this file — adding a new event means editing exactly one
// module.
//
// Digital collections (mobile-dev-docs/15-digital-collections/13 §4.2, 03 §B.6)
// add five `collection.*` events. They go to owners by role and to staff by
// PERMISSION (EVENT_RECIPIENT_PERMISSION), never by role alone.

import type { Permission } from "@/lib/permissions";

export const NOTIFICATION_EVENT_TYPES = [
  "sale.created",
  "purchase.received",
  "inventory.low_stock",
  "payment.deferred_settled",
  "leave.requested",
  "collection.pending",
  "collection.stale",
  "collection.unmatched_credit",
  "collection.source_silent",
  "collection.limit_warning",
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export type TenantMemberRole = "owner" | "staff";
export type NotificationChannel = "in_app" | "email";
export type DigestMode = "instant" | "digest";

export interface EventPreference {
  inApp: boolean;
  email: boolean;
  digestMode: DigestMode;
}

/** Which recipient roles receive a given event by default.
 *  Staff members who want a specific event still need to opt in via the
 *  settings page, but the code default keeps their inbox quiet. */
export const EVENT_RECIPIENT_ROLES: Record<NotificationEventType, TenantMemberRole[]> = {
  "sale.created": ["owner"],
  "purchase.received": ["owner"],
  "inventory.low_stock": ["owner"],
  "payment.deferred_settled": ["owner"],
  "leave.requested": ["owner"],
  "collection.pending": ["owner"],
  "collection.stale": ["owner"],
  "collection.unmatched_credit": ["owner"],
  "collection.source_silent": ["owner"],
  "collection.limit_warning": ["owner"],
};

/** Staff (role 'staff') holding this permission also receive the event — scoped to the event's
 *  branch when the fanout names one (staff are locked to one branch, schema.ts:210-217).
 *  Q1 default (13 §3): recipients by permission, not by role. */
export const EVENT_RECIPIENT_PERMISSION: Partial<Record<NotificationEventType, Permission>> = {
  "collection.pending": "view_collections",
  "collection.stale": "view_collections",
  "collection.unmatched_credit": "view_collections",
  "collection.source_silent": "manage_collection_accounts",
  "collection.limit_warning": "manage_collection_accounts",
};

/** Default preference matrix per (role, event). The dispatcher applies
 *  this when a `notification_preferences` row is missing. */
export const DEFAULT_EVENT_PREFERENCE: Record<
  TenantMemberRole,
  Record<NotificationEventType, EventPreference>
> = {
  owner: {
    // Sales are the highest-volume event. In-app real-time, email as a
    // once-a-day digest so a busy store doesn't flood the owner's inbox.
    "sale.created": { inApp: true, email: true, digestMode: "digest" },
    // Purchases are low-volume + operationally important — instant email.
    "purchase.received": { inApp: true, email: true, digestMode: "instant" },
    "inventory.low_stock": { inApp: true, email: true, digestMode: "instant" },
    "payment.deferred_settled": {
      inApp: true,
      email: true,
      digestMode: "instant",
    },
    "leave.requested": { inApp: true, email: true, digestMode: "instant" },
    // Collections (13 §4.2 + D13-2): in-app on for all five; email off except
    // `source_silent` (rare, and it means money is no longer being checked).
    // `pending` is digest mode, so it never buzzes the phone per sale.
    "collection.pending": { inApp: true, email: false, digestMode: "digest" },
    "collection.stale": { inApp: true, email: false, digestMode: "instant" },
    "collection.unmatched_credit": { inApp: true, email: false, digestMode: "instant" },
    "collection.source_silent": { inApp: true, email: true, digestMode: "instant" },
    "collection.limit_warning": { inApp: true, email: false, digestMode: "instant" },
  },
  staff: {
    // Staff get in-app pings so they can see activity in their branch UI,
    // but no email by default — email is opt-in per user.
    "sale.created": { inApp: false, email: false, digestMode: "digest" },
    "purchase.received": { inApp: true, email: false, digestMode: "instant" },
    "inventory.low_stock": { inApp: true, email: false, digestMode: "instant" },
    "payment.deferred_settled": {
      inApp: false,
      email: false,
      digestMode: "instant",
    },
    "leave.requested": { inApp: false, email: false, digestMode: "instant" },
    // Collections: these rows apply only to staff who hold the event's
    // EVENT_RECIPIENT_PERMISSION (nobody else receives them). Staff never get
    // email by default (D13-2).
    "collection.pending": { inApp: true, email: false, digestMode: "digest" },
    "collection.stale": { inApp: true, email: false, digestMode: "instant" },
    "collection.unmatched_credit": { inApp: true, email: false, digestMode: "instant" },
    "collection.source_silent": { inApp: true, email: false, digestMode: "instant" },
    "collection.limit_warning": { inApp: true, email: false, digestMode: "instant" },
  },
};

/** Section labels of the daily email digest (app/api/cron/notifications-digest),
 *  moved here from that route's labelAr/labelEn switch (13 §4.2) so a new
 *  event cannot be forgotten: the Record is exhaustive. */
export const EVENT_LABELS: Record<NotificationEventType, { ar: string; en: string }> = {
  "sale.created": { ar: "المبيعات", en: "Sales" },
  "purchase.received": { ar: "التوريدات المستلمة", en: "Purchases received" },
  "inventory.low_stock": { ar: "تنبيهات مخزون منخفض", en: "Low stock alerts" },
  "payment.deferred_settled": { ar: "مدفوعات آجل مسدّدة", en: "Deferred settlements" },
  "leave.requested": { ar: "طلبات إجازة", en: "Leave requests" },
  "collection.pending": { ar: "تحويلات في انتظار التأكيد", en: "Transfers awaiting confirmation" },
  "collection.stale": { ar: "تحويلات تأخّر تأكيدها", en: "Transfers waiting too long" },
  "collection.unmatched_credit": { ar: "مبالغ وصلت دون بيع مطابق", en: "Money with no matching sale" },
  "collection.source_silent": { ar: "توقّف التأكيد التلقائي", en: "Automatic confirmation stopped" },
  "collection.limit_warning": { ar: "محافظ اقتربت من الحد", en: "Wallets near their limit" },
};

/** Web link a producer's payload falls back to when it carries none (13 §4.2).
 *  07's `collection.unmatched_credit` payload has no `link` (07 §4.2). The
 *  limit-warning producer adds `&account=<id>&warning=<w>` itself (D13-3). */
export const DEFAULT_EVENT_LINK: Partial<Record<NotificationEventType, string>> = {
  "collection.pending": "/collections?status=pending",
  "collection.stale": "/collections?status=pending&stale=1",
  "collection.unmatched_credit": "/collections?tab=credits",
  "collection.source_silent": "/settings/collections",
  "collection.limit_warning": "/collections?tab=totals",
};

/**
 * The events a member may configure (and can ever receive) — the list the
 * preferences GET returns (13 D13-8). Events without an
 * EVENT_RECIPIENT_PERMISSION entry are always listed. A collection event is
 * listed when COLLECTIONS_ENABLED admits the tenant (`collectionsAdmitted`,
 * 05 `collectionsTenantAdmitted`) and the member is the owner or holds the
 * event's permission.
 */
export function visibleEventTypes(
  role: TenantMemberRole,
  permissions: readonly string[],
  collectionsAdmitted: boolean,
): NotificationEventType[] {
  return NOTIFICATION_EVENT_TYPES.filter((e) => {
    const perm = EVENT_RECIPIENT_PERMISSION[e];
    if (!perm) return true;
    return collectionsAdmitted && (role === "owner" || permissions.includes(perm));
  });
}

/** Resolve the effective preference for a recipient by layering a stored
 *  row on top of the role default. */
export function resolvePreference(
  role: TenantMemberRole,
  eventType: NotificationEventType,
  stored: Partial<EventPreference> | null,
): EventPreference {
  const base = DEFAULT_EVENT_PREFERENCE[role][eventType];
  if (!stored) return base;
  return {
    inApp: stored.inApp ?? base.inApp,
    email: stored.email ?? base.email,
    digestMode: stored.digestMode ?? base.digestMode,
  };
}

export function isNotificationEventType(v: string): v is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(v);
}
