// Notification dispatcher. Domain code calls `fanoutEvent` right after a
// business event commits (a sale, a purchase received, etc.). This module
// figures out who should hear about it (role filter → preferences),
// renders localized in-app + email copy per recipient, writes in-app rows,
// sends instant emails, and buffers digestable events for the daily cron.
//
// Dispatch is fire-and-forget from the caller's point of view: we catch and
// log our own errors so a failed email never rolls back a sale. Domain
// authors just pass structured payload fields; localisation lives here so
// every recipient sees copy in their own preferred locale.

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
import { createNotification, type NotificationKind } from "@/lib/repo/notifications";
import {
  DEFAULT_EVENT_PREFERENCE,
  EVENT_RECIPIENT_ROLES,
  type EventPreference,
  type NotificationEventType,
  type TenantMemberRole,
} from "./event-types";

// ─── Payload shapes ──────────────────────────────────────────────────────────
// Callers pass only structured facts; copy (title/body/subject) is rendered
// per-recipient from these fields, in the recipient's locale.

interface BaseEventPayload {
  /** In-app deep link (e.g. `/sales`, `/purchases/abc`). */
  link?: string | null;
  /** Optional actor to exclude from fanout — e.g. the user who submitted a
   *  leave request shouldn't get notified about their own submission. */
  actorUserId?: string | null;
}

interface SaleCreatedPayload extends BaseEventPayload {
  invoiceId: string;
  totalEgp: number;
  lineCount: number;
  branchName?: string | null;
}

interface PurchaseReceivedPayload extends BaseEventPayload {
  poShortId: string;
  supplierName?: string | null;
  totalEgp: number;
  itemCount: number;
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
  amountEgp: number;
  invoicesSettled: number;
  newBalanceEgp: number;
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

// Notification `kind` column values. We reuse the existing loose enum
// rather than adding a column per event type — the `kind` is what the
// notification bell UI groups on today.
const EVENT_TO_KIND: Record<NotificationEventType, NotificationKind> = {
  "sale.created": "info",
  "purchase.received": "info",
  "inventory.low_stock": "low_stock",
  "payment.deferred_settled": "info",
  "leave.requested": "leave_submitted",
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
  const kind = EVENT_TO_KIND[eventType];

  await withTenant(tenantId, async (tx) => {
    for (const r of eligible) {
      const pref = resolveMemberPref(
        r.role as TenantMemberRole,
        eventType,
        storedByUser.get(r.userId) ?? null,
      );
      const locale = (r.locale === "en" ? "en" : "ar") as "ar" | "en";

      if (pref.inApp) {
        const { title, body } = renderInApp(eventType, payload, locale);
        await createNotification(tx, tenantId, branchId, {
          userId: r.userId,
          kind,
          title,
          body,
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
            locale,
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

// ─── Copy rendering ──────────────────────────────────────────────────────────
// One switch each for in-app and email. In-app strings are tight — they
// render inside the notification bell dropdown; email is only slightly more
// verbose. Both are per-recipient by locale so a mixed ar/en team sees
// their own language.

function fmtEgp(n: number): string {
  const rounded = Math.round(n);
  return rounded.toLocaleString("en-US");
}

interface RenderedInApp {
  title: string;
  body: string | null;
}

/** Render the notification bell copy for a single recipient. */
export function renderInApp<E extends NotificationEventType>(
  eventType: E,
  payload: EventPayloadMap[E],
  locale: "ar" | "en",
): RenderedInApp {
  const ar = locale === "ar";
  switch (eventType) {
    case "sale.created": {
      const p = payload as SaleCreatedPayload;
      return ar
        ? {
            title: `بيع جديد — ${fmtEgp(p.totalEgp)} ج.م`,
            body: p.branchName
              ? `${p.branchName} · فاتورة ${p.invoiceId}`
              : `فاتورة ${p.invoiceId}`,
          }
        : {
            title: `New sale — EGP ${fmtEgp(p.totalEgp)}`,
            body: p.branchName
              ? `${p.branchName} · Invoice ${p.invoiceId}`
              : `Invoice ${p.invoiceId}`,
          };
    }
    case "purchase.received": {
      const p = payload as PurchaseReceivedPayload;
      return ar
        ? {
            title: `استلام شحنة — ${fmtEgp(p.totalEgp)} ج.م`,
            body: `${p.supplierName ?? "مورد"} · ${p.itemCount} صنف`,
          }
        : {
            title: `Purchase received — EGP ${fmtEgp(p.totalEgp)}`,
            body: `${p.supplierName ?? "Supplier"} · ${p.itemCount} items`,
          };
    }
    case "inventory.low_stock": {
      const p = payload as LowStockPayload;
      return ar
        ? {
            title: `مخزون منخفض — ${p.productName}`,
            body: `${p.remainingQty} متبقّي (الحد ${p.threshold})`,
          }
        : {
            title: `Low stock — ${p.productName}`,
            body: `${p.remainingQty} left (threshold ${p.threshold})`,
          };
    }
    case "payment.deferred_settled": {
      const p = payload as DeferredSettledPayload;
      return ar
        ? {
            title: `سداد آجل — ${p.customerName}`,
            body: `دفع ${fmtEgp(p.amountEgp)} ج.م · متبقّي ${fmtEgp(p.newBalanceEgp)} ج.م`,
          }
        : {
            title: `Deferred payment — ${p.customerName}`,
            body: `Paid EGP ${fmtEgp(p.amountEgp)} · balance EGP ${fmtEgp(p.newBalanceEgp)}`,
          };
    }
    case "leave.requested": {
      const p = payload as LeaveRequestedPayload;
      return ar
        ? {
            title: `طلب إجازة — ${p.requesterName}`,
            body: `بانتظار الموافقة · ${p.dayCount} يوم`,
          }
        : {
            title: `Leave request — ${p.requesterName}`,
            body: `Awaiting approval · ${p.dayCount} day${p.dayCount === 1 ? "" : "s"}`,
          };
    }
    default:
      return { title: eventType, body: null };
  }
}

function renderEmail<E extends NotificationEventType>(
  eventType: E,
  payload: EventPayloadMap[E],
  tenantName: string,
  locale: "ar" | "en",
): { subject: string; text: string } {
  const ar = locale === "ar";
  const store = tenantName ? ` — ${tenantName}` : "";
  const footer = ar
    ? `\n\nستورو${tenantName ? ` — ${tenantName}` : ""}`
    : `\n\nTheStoro${tenantName ? ` — ${tenantName}` : ""}`;
  const inApp = renderInApp(eventType, payload, locale);
  const body = `${inApp.title}${inApp.body ? `\n${inApp.body}` : ""}${footer}`;

  switch (eventType) {
    case "sale.created": {
      const p = payload as SaleCreatedPayload;
      return {
        subject: ar
          ? `بيع جديد — ${fmtEgp(p.totalEgp)} ج.م${store}`
          : `New sale — EGP ${fmtEgp(p.totalEgp)}${store}`,
        text: body,
      };
    }
    case "purchase.received": {
      const p = payload as PurchaseReceivedPayload;
      return {
        subject: ar
          ? `استلام شحنة #${p.poShortId}${store}`
          : `Purchase received #${p.poShortId}${store}`,
        text: body,
      };
    }
    case "inventory.low_stock": {
      const p = payload as LowStockPayload;
      return {
        subject: ar
          ? `تنبيه مخزون منخفض — ${p.productName}${store}`
          : `Low stock — ${p.productName}${store}`,
        text: body,
      };
    }
    case "payment.deferred_settled": {
      const p = payload as DeferredSettledPayload;
      return {
        subject: ar
          ? `سداد آجل — ${p.customerName}${store}`
          : `Deferred payment settled — ${p.customerName}${store}`,
        text: body,
      };
    }
    case "leave.requested": {
      const p = payload as LeaveRequestedPayload;
      return {
        subject: ar
          ? `طلب إجازة — ${p.requesterName}${store}`
          : `Leave request — ${p.requesterName}${store}`,
        text: body,
      };
    }
    default:
      return { subject: inApp.title, text: body };
  }
}
