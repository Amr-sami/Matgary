// Registry of the events the notification system knows about + per-role
// defaults. A row in `notification_preferences` overrides these; when no row
// exists the dispatcher applies the code default for the recipient's role.
//
// Everything the settings UI, the dispatcher, and the email templates read
// funnels through this file — adding a new event means editing exactly one
// module.

export const NOTIFICATION_EVENT_TYPES = [
  "sale.created",
  "purchase.received",
  "inventory.low_stock",
  "payment.deferred_settled",
  "leave.requested",
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
  },
};

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
