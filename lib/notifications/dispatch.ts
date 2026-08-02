// Notification dispatcher. Domain code calls `fanoutEvent` right after a
// business event commits (a sale, a purchase received, etc.). This module
// figures out who should hear about it (role filter → preferences),
// writes in-app rows, sends instant emails, and buffers digestable events
// for the daily cron.
//
// Dispatch is fire-and-forget from the caller's point of view: we catch and
// log our own errors so a failed email never rolls back a sale. Domain
// authors just pass a payload; the mapping to titles, bodies, and email
// subjects lives entirely in this file.

import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  notificationDigestQueue,
  notificationPreferences,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { sendMail } from "@/lib/mailer";
import { createNotification } from "@/lib/repo/notifications";
import {
  DEFAULT_EVENT_PREFERENCE,
  EVENT_RECIPIENT_ROLES,
  type EventPreference,
  type NotificationEventType,
  type TenantMemberRole,
} from "./event-types";

// ─── Payload shapes ──────────────────────────────────────────────────────────
// One shape per event type. `title` / `body` are the strings the recipient
// sees; the caller renders them because it has the domain context (customer
// name, product name, etc.) that this module doesn't know about.

interface BaseEventPayload {
  title: string;
  body?: string | null;
  /** In-app deep link (e.g. `/sales`, `/purchases/abc`). */
  link?: string | null;
  /** Optional actor to exclude from fanout — e.g. the user who submitted a
   *  leave request shouldn't get notified about their own submission. */
  actorUserId?: string | null;
}

interface SaleCreatedPayload extends BaseEventPayload {
  saleNumber: number | string;
  totalEgp: string | number;
  branchName?: string | null;
}

interface PurchaseReceivedPayload extends BaseEventPayload {
  poNumber?: string | null;
  supplierName?: string | null;
  totalEgp?: string | number | null;
  branchName?: string | null;
}

interface LowStockPayload extends BaseEventPayload {
  productName: string;
  remainingQty: number;
  threshold: number;
  branchName?: string | null;
}

interface DeferredSettledPayload extends BaseEventPayload {
  customerName: string;
  amountEgp: string | number;
  saleNumber: number | string;
}

interface LeaveRequestedPayload extends BaseEventPayload {
  requesterName: string;
  dayCount: number;
}

export type EventPayloadMap = {
  "sale.created": SaleCreatedPayload;
  "purchase.received": PurchaseReceivedPayload;
  "inventory.low_stock": LowStockPayload;
  "payment.deferred_settled": DeferredSettledPayload;
  "leave.requested": LeaveRequestedPayload;
};

// ─── Public API ──────────────────────────────────────────────────────────────

/** Fire an event out to every eligible tenant member. Never throws — the
 *  dispatcher's own failures land in the logger, not the caller's stack. */
export async function fanoutEvent<E extends NotificationEventType>(
  tenantId: string,
  branchId: string | null,
  eventType: E,
  payload: EventPayloadMap[E],
): Promise<void> {
  try {
    await doFanout(tenantId, branchId, eventType, payload);
  } catch (err) {
    logger.error({
      event: "notif.dispatch_failed",
      tenantId,
      eventType,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

async function doFanout<E extends NotificationEventType>(
  tenantId: string,
  branchId: string | null,
  eventType: E,
  payload: EventPayloadMap[E],
): Promise<void> {
  const recipientRoles = EVENT_RECIPIENT_ROLES[eventType];
  if (recipientRoles.length === 0) return;

  // 1) Recipients — every member whose role is in the recipient list.
  //    Skip the actor if the payload names one (see leave.requested).
  const recipients = await withTenant(tenantId, async (tx) => {
    return tx
      .select({
        userId: tenantMembers.userId,
        role: tenantMembers.role,
        email: users.email,
        name: users.name,
        locale: users.locale,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          inArray(tenantMembers.role, recipientRoles as string[]),
        ),
      );
  });

  const eligible = payload.actorUserId
    ? recipients.filter((r) => r.userId !== payload.actorUserId)
    : recipients;
  if (eligible.length === 0) return;

  // 2) Preferences — one query for every recipient at once.
  const stored = await withTenant(tenantId, async (tx) => {
    return tx
      .select({
        userId: notificationPreferences.userId,
        inApp: notificationPreferences.inApp,
        email: notificationPreferences.email,
        digestMode: notificationPreferences.digestMode,
      })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.tenantId, tenantId),
          eq(notificationPreferences.eventType, eventType),
          inArray(
            notificationPreferences.userId,
            eligible.map((e) => e.userId),
          ),
        ),
      );
  });
  const storedByUser = new Map(stored.map((s) => [s.userId, s]));

  // 3) Fetch tenant display name once — used in every email subject.
  const [tenantRow] = await withTenant(tenantId, async (tx) =>
    tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
  );
  const tenantName = tenantRow?.name ?? "";

  // 4) Fan out per recipient. Everything runs in one tenant tx so RLS stays
  //    tight; email sends kick off after the tx commits so their latency
  //    doesn't hold DB rows open.
  interface EmailJob {
    to: string;
    subject: string;
    text: string;
  }
  const emailJobs: EmailJob[] = [];

  await withTenant(tenantId, async (tx) => {
    for (const r of eligible) {
      const pref = resolveMemberPref(
        r.role as TenantMemberRole,
        eventType,
        storedByUser.get(r.userId) ?? null,
      );

      if (pref.inApp) {
        await createNotification(tx, tenantId, branchId, {
          userId: r.userId,
          kind: eventType,
          title: payload.title,
          body: payload.body ?? null,
          link: payload.link ?? null,
        });
      }

      if (pref.email && r.email) {
        if (pref.digestMode === "digest") {
          await tx.insert(notificationDigestQueue).values({
            tenantId,
            userId: r.userId,
            eventType,
            payload: payload as unknown as Record<string, unknown>,
          });
        } else {
          const { subject, text } = renderEmail(
            eventType,
            payload,
            tenantName,
            r.locale as "ar" | "en",
          );
          emailJobs.push({ to: r.email, subject, text });
        }
      }
    }
  });

  // 5) Emails after the tx — parallel but not awaited by caller.
  void Promise.all(
    emailJobs.map((job) =>
      sendMail(job).catch((err) => {
        logger.error({
          event: "notif.email_send_failed",
          to: job.to,
          eventType,
          reason: err instanceof Error ? err.message : String(err),
        });
      }),
    ),
  );
}

function resolveMemberPref(
  role: TenantMemberRole,
  eventType: NotificationEventType,
  stored: {
    inApp: boolean;
    email: boolean;
    digestMode: string;
  } | null,
): EventPreference {
  const base = DEFAULT_EVENT_PREFERENCE[role]?.[eventType]
    ?? DEFAULT_EVENT_PREFERENCE.staff[eventType];
  if (!stored) return base;
  return {
    inApp: stored.inApp,
    email: stored.email,
    digestMode: stored.digestMode === "digest" ? "digest" : "instant",
  };
}

// ─── Email rendering ─────────────────────────────────────────────────────────
// The in-app title/body come from the caller (localized in the domain layer).
// For email we don't have the caller's dictionary handy, so we render a very
// short plaintext template here in the recipient's locale. Consciously terse
// — the goal is "you got a ping, click the app for details," not a full
// message.

function renderEmail<E extends NotificationEventType>(
  eventType: E,
  payload: EventPayloadMap[E],
  tenantName: string,
  locale: "ar" | "en",
): { subject: string; text: string } {
  const isAr = locale === "ar";
  const store = tenantName ? ` — ${tenantName}` : "";

  switch (eventType) {
    case "sale.created": {
      const p = payload as SaleCreatedPayload;
      return {
        subject: isAr
          ? `بيع جديد #${p.saleNumber}${store}`
          : `New sale #${p.saleNumber}${store}`,
        text: isAr
          ? `${p.title}\n\n${p.body ?? ""}\n\nستورو — ${tenantName}`
          : `${p.title}\n\n${p.body ?? ""}\n\nTheStoro — ${tenantName}`,
      };
    }
    case "purchase.received": {
      const p = payload as PurchaseReceivedPayload;
      return {
        subject: isAr
          ? `توريد جديد${p.poNumber ? ` #${p.poNumber}` : ""}${store}`
          : `Purchase received${p.poNumber ? ` #${p.poNumber}` : ""}${store}`,
        text: `${p.title}\n\n${p.body ?? ""}`,
      };
    }
    case "inventory.low_stock": {
      const p = payload as LowStockPayload;
      return {
        subject: isAr
          ? `تنبيه مخزون منخفض — ${p.productName}${store}`
          : `Low stock — ${p.productName}${store}`,
        text: `${p.title}\n\n${p.body ?? ""}`,
      };
    }
    case "payment.deferred_settled": {
      const p = payload as DeferredSettledPayload;
      return {
        subject: isAr
          ? `تم سداد آجل — ${p.customerName}${store}`
          : `Deferred payment settled — ${p.customerName}${store}`,
        text: `${p.title}\n\n${p.body ?? ""}`,
      };
    }
    case "leave.requested": {
      const p = payload as LeaveRequestedPayload;
      return {
        subject: isAr
          ? `طلب إجازة جديد — ${p.requesterName}${store}`
          : `Leave request — ${p.requesterName}${store}`,
        text: `${p.title}\n\n${p.body ?? ""}`,
      };
    }
    default: {
      const p = payload as BaseEventPayload;
      return { subject: p.title, text: `${p.title}\n\n${p.body ?? ""}` };
    }
  }
}
