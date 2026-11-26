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

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  notificationDigestQueue,
  notificationPreferences,
  tenantMembers,
  tenantNotificationOverrides,
  tenants,
  users,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { sendMail } from "@/lib/mailer";
import { createNotification, DEFAULT_PUSH, type NotificationKind } from "@/lib/repo/notifications";
import {
  DEFAULT_EVENT_LINK,
  DEFAULT_EVENT_PREFERENCE,
  EVENT_RECIPIENT_PERMISSION,
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

// Digital collections (mobile-dev-docs/15-digital-collections/13 §4.3; 03 §B.6
// pins the producers). Q18: no payload carries a field about the person who
// paid (name, number or bank reference) — push text leaves the country through
// Apple and Google, so only the owner's account label, an ASCII mask and
// amounts are ever rendered. `customerName` is the shop's own customer record
// and is never rendered in the copy below.

export interface CollectionPendingPayload extends BaseEventPayload {
  // producer 05 (its §4.19)
  invoiceId: string | null;
  sourceType: "sale" | "settlement";
  method: "instapay" | "wallet";
  amountEgp: number;
  partsCount: number;
  accountLabel: string | null;
  customerName: string | null;
  branchName: string;
}

export interface CollectionStalePayload extends BaseEventPayload {
  // producer 13 (staleSweep): one per (tenant, branch) per sweep, D13-1
  branchName: string | null;
  count: number;
  amountEgp: number;
  staleAfterMinutes: number;
}

export interface CollectionUnmatchedPayload extends BaseEventPayload {
  // producer 07 (its §4.2 / §4.12); carries no `link` → DEFAULT_EVENT_LINK
  creditId: string;
  accountId: string | null;
  accountLabel: string | null;
  amount: number;
  state: "unmatched" | "held";
  holdReason: string | null;
  suggestedCollectionId: string | null;
  rejectedCollectionId?: string | null;
}

export interface CollectionSourceSilentPayload extends BaseEventPayload {
  // producer 13 (silentSourceSweep, M2)
  deviceId: string;
  deviceLabel: string;
  platform: string;
  missedCount: number;
  branchName: string | null;
}

export type CollectionLimitWarning = "day_80" | "month_80" | "new_wallet_day_80" | "balance_90";

export interface CollectionLimitPayload extends BaseEventPayload {
  // producer 13 (limitSweep); `link` carries &account=<id>&warning=<w> (D13-3)
  accountId: string;
  accountLabel: string;
  accountMask: string;
  provider: string;
  warning: CollectionLimitWarning; // = LimitWarning (06 §4.5)
  /** Day total (day_80, new_wallet_day_80), month total (month_80), or the balance (balance_90). */
  receivedEgp: number;
  /** dayMax / monthMax / newWallet.dayMax / balance cap; null when the provider has none. */
  limitEgp: number | null;
}

/**
 * Weekly / monthly report fan-out payload (doc 16 §report-nav).
 *
 * Kept tiny on purpose: the push data carries only the period identifier and
 * optional preview numbers; the authoritative report fetch happens on tap
 * (`GET /api/reports/<kind>?period=`), so the push stays well under Expo's
 * 4 KB cap and the report always reflects the latest DB state at the moment
 * the owner opens it.
 */
export interface ReportPayload extends BaseEventPayload {
  /** Period identifier: ISO week `2026-W47` for weekly, `2026-11` for monthly. */
  period: string;
  /** Headline revenue for the period — rendered inline so the owner sees it
   *  on the lock screen without having to open the app. Null if unavailable. */
  totalRevenueEgp?: number | null;
  /** Count of sales in the period, for the subtitle. */
  salesCount?: number | null;
}

/** Instant generic events. Each carries an actor name (for the body line) and
 *  a stable route-worthy identifier (expenseId, productId, …). Kept tiny:
 *  the detail screens fetch the authoritative row on tap. */
export interface ExpenseRecordedPayload extends BaseEventPayload {
  expenseId: string;
  title: string;
  amountEgp: number;
  category: string;
  actorName?: string | null;
}

export interface ProductAddedPayload extends BaseEventPayload {
  productId: string;
  productName: string;
  actorName?: string | null;
}

export interface InventoryAdjustedPayload extends BaseEventPayload {
  productId: string;
  productName: string;
  deltaQty: number;
  newQty: number;
  actorName?: string | null;
}

export interface ReturnRecordedPayload extends BaseEventPayload {
  returnId: string;
  invoiceId: string | null;
  /** Null when the producer didn't fetch the amount (cheap-path fire). */
  amountEgp: number | null;
  actorName?: string | null;
}

export interface AttendanceCheckInPayload extends BaseEventPayload {
  employeeUserId: string;
  employeeName: string;
  /** ISO timestamp of the check-in. */
  occurredAt: string;
}

// ── Notification Center extension payloads ────────────────────────────────

export interface PurchaseCreatedPayload extends BaseEventPayload {
  purchaseOrderId: string;
  supplierName: string;
  itemCount: number;
  totalEgp: number;
  actorName?: string | null;
}

export interface PurchaseReturnedPayload extends BaseEventPayload {
  purchaseOrderId: string;
  supplierName: string;
  reason?: string | null;
  actorName?: string | null;
}

export interface SupplierPaymentRecordedPayload extends BaseEventPayload {
  supplierId: string;
  supplierName: string;
  amountEgp: number;
  method: string;
  /** Payment mode — `po` (allocated to a specific PO) or `account` (account-level). */
  kind: "po" | "account";
  /** Only set for `kind='po'`. */
  purchaseOrderId?: string | null;
  /** Server-computed new supplier balance after the payment committed. */
  remainingBalanceEgp?: number | null;
  actorName?: string | null;
}

export interface CustomerCreatedPayload extends BaseEventPayload {
  customerPhone: string;
  customerName?: string | null;
  firstSaleId?: string | null;
  firstSaleAmountEgp?: number | null;
}

export interface ExpenseVoidedPayload extends BaseEventPayload {
  expenseId: string;
  title: string;
  amountEgp: number;
  actorName?: string | null;
}

export interface LeaveApprovedPayload extends BaseEventPayload {
  leaveRequestId: string;
  requesterUserId: string;
  requesterName: string;
  dayCount: number;
  approverName?: string | null;
}

export interface LeaveRejectedPayload extends BaseEventPayload {
  leaveRequestId: string;
  requesterUserId: string;
  requesterName: string;
  reason?: string | null;
  decidedByName?: string | null;
}

export interface PayrollCalculatedPayload extends BaseEventPayload {
  payrollPeriodId: string;
  employeeUserId: string;
  employeeName: string;
  month: string; // YYYY-MM
  netEgp: number;
}

export interface PayrollFinalizedPayload extends BaseEventPayload {
  payrollPeriodId: string;
  employeeUserId: string;
  employeeName: string;
  month: string;
  netEgp: number;
  finalizedByName?: string | null;
}

export interface PayrollVoidedPayload extends BaseEventPayload {
  payrollPeriodId: string;
  employeeUserId: string;
  employeeName: string;
  month: string;
  voidedByName?: string | null;
  reason?: string | null;
}

/** `attendance.late` payload — all values authoritative at the moment the
 *  sweep fired. `lateMinutes` is `(now_local − (shift_start + grace))`. */
export interface AttendanceLatePayload extends BaseEventPayload {
  employeeUserId: string;
  employeeName: string;
  date: string; // YYYY-MM-DD local
  scheduledStart: string; // HH:mm
  graceMinutes: number;
  lateMinutes: number;
  actualCheckIn?: string | null; // ISO or null (no check-in yet)
}

export type EventPayloadMap = {
  "sale.created": SaleCreatedPayload;
  // Never fanned out (EVENT_RECIPIENT_ROLES is empty); alertSale delivers it.
  "sale.alert": never;
  "purchase.received": PurchaseReceivedPayload;
  "inventory.low_stock": LowStockPayload;
  "payment.deferred_settled": DeferredSettledPayload;
  "leave.requested": LeaveRequestedPayload;
  "collection.pending": CollectionPendingPayload;
  "collection.stale": CollectionStalePayload;
  "collection.unmatched_credit": CollectionUnmatchedPayload;
  "collection.source_silent": CollectionSourceSilentPayload;
  "collection.limit_warning": CollectionLimitPayload;
  "report.weekly": ReportPayload;
  "report.monthly": ReportPayload;
  "expense.recorded": ExpenseRecordedPayload;
  "product.added": ProductAddedPayload;
  "inventory.adjusted": InventoryAdjustedPayload;
  "return.recorded": ReturnRecordedPayload;
  "attendance.check_in": AttendanceCheckInPayload;
  "purchase.created": PurchaseCreatedPayload;
  "purchase.returned": PurchaseReturnedPayload;
  "supplier.payment.recorded": SupplierPaymentRecordedPayload;
  "customer.created": CustomerCreatedPayload;
  "expense.voided": ExpenseVoidedPayload;
  "leave.approved": LeaveApprovedPayload;
  "leave.rejected": LeaveRejectedPayload;
  "payroll.calculated": PayrollCalculatedPayload;
  "payroll.finalized": PayrollFinalizedPayload;
  "payroll.voided": PayrollVoidedPayload;
  "report.daily": ReportPayload;
  "attendance.late": AttendanceLatePayload;
};

// Notification `kind` column values. We reuse the existing loose enum
// rather than adding a column per event type — the `kind` is what the
// notification bell UI groups on today. Collection events map 1:1 (13 §4.6),
// so muting one also mutes its push (lib/push/notify.ts KIND_TO_EVENT).
export const EVENT_TO_KIND: Record<NotificationEventType, NotificationKind> = {
  "sale.created": "info",
  "sale.alert": "info", // unused — sale alerts write no notifications row
  "purchase.received": "info",
  "inventory.low_stock": "low_stock",
  "payment.deferred_settled": "info",
  "leave.requested": "leave_submitted",
  "collection.pending": "collection_pending",
  "collection.stale": "collection_stale",
  "collection.unmatched_credit": "collection_unmatched",
  "collection.source_silent": "collection_source_silent",
  "collection.limit_warning": "collection_limit",
  "report.weekly": "report",
  "report.monthly": "report",
  "expense.recorded": "info",
  "product.added": "info",
  "inventory.adjusted": "info",
  "return.recorded": "info",
  "attendance.check_in": "info",
  // Notification Center extension — all route through the generic `"info"`
  // kind so they inherit the Universfield push sound via
  // lib/push/notify.ts:soundForKind("info") → generic_notification.wav. The
  // sale.created mapping above is also "info" but dispatch never pushes it
  // (sale.alert is the phone chime path).
  "purchase.created": "info",
  "purchase.returned": "info",
  "supplier.payment.recorded": "info",
  "customer.created": "info",
  "expense.voided": "info",
  "leave.approved": "leave_decided",
  "leave.rejected": "leave_decided",
  "payroll.calculated": "info",
  "payroll.finalized": "info",
  "payroll.voided": "info",
  "report.daily": "report",
  "attendance.late": "info",
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
  const recipientPerm = EVENT_RECIPIENT_PERMISSION[eventType];
  if (recipientRoles.length === 0 && !recipientPerm) return;

  // 1) Recipients — every member whose role is in the recipient list, plus
  //    (collections, 13 §4.4) every staff member holding the event's
  //    permission, scoped to the event's branch when the fanout names one.
  //    Skip the actor if the payload names one (see leave.requested).
  const audience: SQL[] = [];
  if (recipientRoles.length > 0) {
    audience.push(inArray(tenantMembers.role, recipientRoles as string[]));
  }
  if (recipientPerm) {
    audience.push(
      and(
        eq(tenantMembers.role, "staff"),
        // Bound parameter, never interpolated text.
        sql`${tenantMembers.permissions} @> ARRAY[${recipientPerm}]::text[]`,
        branchId ? eq(tenantMembers.branchId, branchId) : undefined,
      )!,
    );
  }
  const recipients = await withTenant(tenantId, async (tx) => {
    return tx
      .select({
        userId: tenantMembers.userId,
        role: tenantMembers.role,
        email: users.email,
        name: users.name,
        locale: users.locale,
        // `receive_all_alerts` (permissions.ts) is a preference override, not
        // an authz bypass — a member who already is in `eligible` opts into
        // every event they are role-eligible for, regardless of whether they
        // toggled it off on the notification-preferences screen.
        permissions: tenantMembers.permissions,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          audience.length === 1 ? audience[0] : or(...audience),
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
        push: notificationPreferences.push,
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

  // 2b) Tenant-level override — one row per (tenant, event_type). When
  //     enabled=false, the owner has disabled this event at the tenant level,
  //     which zeros out in-app + email + push for every member whose own
  //     preference row doesn't explicitly re-enable the channel. See
  //     resolveMemberPref below for the precedence rules.
  const [tenantOverride] = await withTenant(tenantId, async (tx) => {
    return tx
      .select({ enabled: tenantNotificationOverrides.enabled })
      .from(tenantNotificationOverrides)
      .where(
        and(
          eq(tenantNotificationOverrides.tenantId, tenantId),
          eq(tenantNotificationOverrides.eventType, eventType),
        ),
      )
      .limit(1);
  });
  const tenantDisabled = tenantOverride?.enabled === false;

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
  // 07's unmatched-credit payload names no link; the registry supplies it.
  const link = payload.link ?? DEFAULT_EVENT_LINK[eventType] ?? null;

  await withTenant(tenantId, async (tx) => {
    for (const r of eligible) {
      const basePref = resolveMemberPref(
        r.role as TenantMemberRole,
        eventType,
        storedByUser.get(r.userId) ?? null,
        tenantDisabled,
      );
      // receive_all_alerts (permissions.ts) upgrades the in-app + push
      // delivery for any event this member is already role/permission-eligible
      // for. It does NOT flip email on — email is a separate channel the
      // owner opts into explicitly. Owner always has every permission.
      const hasAllAlerts =
        r.role === "owner" || (Array.isArray(r.permissions) && r.permissions.includes("receive_all_alerts"));
      const pref: EventPreference = hasAllAlerts
        ? { inApp: true, email: basePref.email, digestMode: "instant" }
        : basePref;
      const locale = (r.locale === "en" ? "en" : "ar") as "ar" | "en";

      if (pref.inApp) {
        const { title, body } = renderInApp(eventType, payload, locale);
        const role = r.role as TenantMemberRole;
        await createNotification(tx, tenantId, branchId, {
          userId: r.userId,
          kind,
          title,
          body,
          link,
          // Digest-mode events (an owner's `sale.created`) show in the bell
          // but do not buzz the phone per event — §8.3. Also honour the
          // stored per-event push switch when the user has set one; with no
          // row the role default applies (DEFAULT_PUSH — the same value the
          // preferences GET reports; `collection.limit_warning` is instant
          // but push-off by default, 13 §4.4).
          // `sale.created` never pushes: the phone chime is `sale.alert`
          // (doc 16 §5) — a staff member who hand-enabled it would otherwise
          // buzz twice per sale.
          push:
            eventType !== "sale.created" &&
            pref.digestMode !== "digest" &&
            // Tenant-wide disable zeros out push too, unless the member has
            // a stored preference row that explicitly re-enables it.
            (!tenantDisabled || storedByUser.get(r.userId)?.push === true) &&
            (hasAllAlerts
              || (storedByUser.get(r.userId)?.push ??
                (DEFAULT_PUSH[role] ?? DEFAULT_PUSH.staff)[eventType])),
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
  tenantDisabled: boolean = false,
): EventPreference {
  // 3-level resolution: user pref → tenant override → system default.
  // Precedence when a user has a stored row: the user row wins (they
  // consciously configured it). Absent a user row, a tenant `enabled=false`
  // zeros out every channel. Otherwise the role default applies.
  const base = DEFAULT_EVENT_PREFERENCE[role]?.[eventType]
    ?? DEFAULT_EVENT_PREFERENCE.staff[eventType];
  if (!stored) {
    if (tenantDisabled) {
      return { inApp: false, email: false, digestMode: "instant" };
    }
    return base;
  }
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

export function fmtEgp(n: number): string {
  const rounded = Math.round(n);
  return rounded.toLocaleString("en-US");
}

// ─── Collections copy helpers (13 §4.5; pure, Western digits) ────────────────

/** 03 §B.9 method labels: never bare «محفظة» / "Wallet" (the loyalty wallet owns that word). */
export function methodName(m: string, ar: boolean): string {
  if (m === "wallet") return ar ? "محفظة موبايل" : "Mobile wallet";
  return ar ? "إنستاباي" : "InstaPay";
}

/** Arabic count phrase: 1 → `one`, 2 → `two`, 3–10 → `{n} few`, ≥ 11 → `{n} many`. */
export function countAr(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** Arabic duration after «منذ أكثر من»: 60 → ساعة, 120 → ساعتين, 3–10 h → ساعات, ≥ 11 h → ساعة. */
export function durAr(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60 || m % 60 !== 0) {
    return countAr(m, "دقيقة", "دقيقتين", "دقائق", "دقيقة");
  }
  return countAr(m / 60, "ساعة", "ساعتين", "ساعات", "ساعة");
}

export function durEn(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60 || m % 60 !== 0) return m === 1 ? "1 minute" : `${m} minutes`;
  const h = m / 60;
  return h === 1 ? "1 hour" : `${h} hours`;
}

export function joinParts(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" · ");
}

function accountRef(label: string | null | undefined, mask: string | null | undefined, ar: boolean): string {
  const name = label && label.trim() ? label.trim() : ar ? "حساب غير معروف" : "an unknown account";
  return mask && mask.trim() ? `${name} ${mask.trim()}` : name;
}

function renderCollectionPending(p: CollectionPendingPayload, ar: boolean): RenderedInApp {
  const parts = Math.max(1, Math.floor(p.partsCount || 1));
  const account = p.accountLabel && p.accountLabel.trim() ? p.accountLabel.trim() : null;
  return ar
    ? {
        title: `تحويل في انتظار التأكيد — ${fmtEgp(p.amountEgp)} ج.م`,
        body: joinParts([
          p.sourceType === "settlement" && "سداد دين",
          methodName(p.method, true),
          account ?? "بدون حساب",
          parts > 1 && countAr(parts, "تحويل", "تحويلان", "تحويلات", "تحويلًا"),
          p.branchName,
        ]),
      }
    : {
        title: `Transfer awaiting confirmation — EGP ${fmtEgp(p.amountEgp)}`,
        body: joinParts([
          p.sourceType === "settlement" && "Debt payment",
          methodName(p.method, false),
          account ?? "no account",
          parts > 1 && `${parts} transfers`,
          p.branchName,
        ]),
      };
}

function renderCollectionStale(p: CollectionStalePayload, ar: boolean): RenderedInApp {
  const n = Math.max(1, Math.floor(p.count || 1));
  if (ar) {
    const dur = durAr(p.staleAfterMinutes);
    const head = countAr(n, "تحويل", "تحويلان", "تحويلات", "تحويلًا");
    return {
      title: `${head} في انتظار التأكيد منذ أكثر من ${dur}`,
      body: joinParts(["راجع تطبيق البنك أو المحفظة", `${fmtEgp(p.amountEgp)} ج.م`, p.branchName]),
    };
  }
  return {
    title: `${n} transfer${n === 1 ? "" : "s"} waiting over ${durEn(p.staleAfterMinutes)}`,
    body: joinParts(["Check your bank or wallet app", `EGP ${fmtEgp(p.amountEgp)}`, p.branchName]),
  };
}

function renderCollectionUnmatched(p: CollectionUnmatchedPayload, ar: boolean): RenderedInApp {
  const amt = fmtEgp(p.amount);
  const label = accountRef(p.accountLabel, null, ar);
  switch (p.holdReason) {
    case "no_account":
      return ar
        ? { title: `وصل ${amt} ج.م`, body: "لم نتمكن من تحديد الحساب الذي استلمه — اختره" }
        : { title: `EGP ${amt} arrived`, body: "We couldn't tell which account received it — pick one" };
    case "balance_mismatch":
      return ar
        ? {
            title: `وصل ${amt} ج.م إلى ${label}`,
            body: "الرصيد في الرسالة لا يتطابق — تحقّق من التطبيق قبل التأكيد",
          }
        : {
            title: `EGP ${amt} arrived on ${label}`,
            body: "The balance in this message doesn't add up — check the app before confirming",
          };
    case "suspicious_link":
      return ar
        ? { title: `وصل ${amt} ج.م إلى ${label}`, body: "تحتوي الرسالة على رابط غير معروف — قد تكون مزيّفة" }
        : { title: `EGP ${amt} arrived on ${label}`, body: "This message has an unknown link — it may be fake" };
    case "matches_rejected":
      return ar
        ? { title: `وصل ${amt} ج.م لتحويل رفضته`, body: "أعد فتحه وأكّده إن كان صحيحًا" }
        : { title: `EGP ${amt} arrived for a transfer you rejected`, body: "Reopen and confirm it if it's right" };
    default:
      break;
  }
  if (p.state === "held") {
    // Any other hold reason: a candidate may exist, so "no matching sale"
    // would be wrong; 02 §4.9 calls a held credit "needs your check".
    return ar
      ? { title: `وصل ${amt} ج.م إلى ${label}`, body: "يحتاج إلى مراجعتك في التحويلات" }
      : { title: `EGP ${amt} arrived on ${label}`, body: "It needs your check in Collections" };
  }
  return ar
    ? { title: `وصل ${amt} ج.م إلى ${label} دون بيع مطابق`, body: "راجعه في التحويلات" }
    : { title: `EGP ${amt} arrived on ${label} with no matching sale`, body: "Review it in Collections" };
}

function renderCollectionSourceSilent(p: CollectionSourceSilentPayload, ar: boolean): RenderedInApp {
  const n = Math.max(1, Math.floor(p.missedCount || 1));
  const device = p.deviceLabel && p.deviceLabel.trim() ? p.deviceLabel.trim() : ar ? "هاتف" : "a phone";
  return ar
    ? {
        title: `توقّف تأكيد التحويلات على ${device} — أعد إعداده`,
        body: `وصل ${countAr(n, "تحويل واحد", "تحويلان", "تحويلات", "تحويلًا")} دون رسالة من هذا الهاتف`,
      }
    : {
        title: `Automatic confirmation stopped on ${device} — set it up again`,
        body: `${n} transfer${n === 1 ? "" : "s"} arrived with no message from this phone`,
      };
}

function renderCollectionLimit(p: CollectionLimitPayload, ar: boolean): RenderedInApp {
  const acct = accountRef(p.accountLabel, p.accountMask, ar);
  const rcv = fmtEgp(p.receivedEgp);
  const lim = p.limitEgp == null ? null : fmtEgp(p.limitEgp);
  if (ar) {
    const ofLimit = lim ? `${rcv} من ${lim} ج.م` : `${rcv} ج.م`;
    switch (p.warning) {
      case "day_80":
        return {
          title: `${acct}: بلغ الاستلام 80٪ من حد اليوم`,
          body: `استلمت اليوم ${ofLimit} — قد يسري الحد على المبالغ المستلمة أيضًا`,
        };
      case "month_80":
        return { title: `${acct}: بلغ الاستلام 80٪ من حد الشهر`, body: `استلمت هذا الشهر ${ofLimit}` };
      case "new_wallet_day_80":
        return {
          title: `${acct}: بلغ الاستلام 80٪ من حد المحافظ الجديدة`,
          body: lim
            ? `قد يكون حد المحافظ التي يقل عمرها عن 90 يومًا ${lim} ج.م في اليوم`
            : "قد يكون للمحافظ التي يقل عمرها عن 90 يومًا حد يومي أقل",
        };
      case "balance_90":
      default:
        return {
          title: `رصيد ${acct} اقترب من الحد الأقصى`,
          body: `الرصيد ${ofLimit} — حوّل جزءًا منه حتى لا تُرفض التحويلات الجديدة`,
        };
    }
  }
  const ofLimit = lim ? `EGP ${rcv} of ${lim}` : `EGP ${rcv}`;
  switch (p.warning) {
    case "day_80":
      return {
        title: `${acct} is at 80% of today's limit`,
        body: `Received today ${ofLimit}. The limit may also apply to money you receive.`,
      };
    case "month_80":
      return { title: `${acct} is at 80% of this month's limit`, body: `Received this month ${ofLimit}.` };
    case "new_wallet_day_80":
      return {
        title: `${acct} is at 80% of the new-wallet day limit`,
        body: lim
          ? `Wallets younger than 90 days may be limited to EGP ${lim} a day.`
          : "Wallets younger than 90 days may have a lower day limit.",
      };
    case "balance_90":
    default:
      return {
        title: `${acct} is near its maximum balance`,
        body: `Balance ${ofLimit}. Move some out so new transfers aren't refused.`,
      };
  }
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
    case "collection.pending":
      return renderCollectionPending(payload as CollectionPendingPayload, ar);
    case "collection.stale":
      return renderCollectionStale(payload as CollectionStalePayload, ar);
    case "collection.unmatched_credit":
      return renderCollectionUnmatched(payload as CollectionUnmatchedPayload, ar);
    case "collection.source_silent":
      return renderCollectionSourceSilent(payload as CollectionSourceSilentPayload, ar);
    case "collection.limit_warning":
      return renderCollectionLimit(payload as CollectionLimitPayload, ar);
    case "report.weekly":
    case "report.monthly": {
      const p = payload as ReportPayload;
      const isWeek = eventType === "report.weekly";
      const titleAr = isWeek ? "التقرير الأسبوعي جاهز" : "التقرير الشهري جاهز";
      const titleEn = isWeek ? "Weekly report ready" : "Monthly report ready";
      const bodyParts: string[] = [p.period];
      if (p.totalRevenueEgp != null) {
        bodyParts.push(ar ? `${fmtEgp(p.totalRevenueEgp)} ج.م` : `EGP ${fmtEgp(p.totalRevenueEgp)}`);
      }
      if (p.salesCount != null) {
        bodyParts.push(ar ? `${p.salesCount} فاتورة` : `${p.salesCount} sales`);
      }
      return ar
        ? { title: titleAr, body: bodyParts.join(" · ") }
        : { title: titleEn, body: bodyParts.join(" · ") };
    }
    case "expense.recorded": {
      const p = payload as ExpenseRecordedPayload;
      return ar
        ? {
            title: `مصروف جديد — ${fmtEgp(p.amountEgp)} ج.م`,
            body: p.actorName ? `${p.title} · ${p.actorName}` : p.title,
          }
        : {
            title: `New expense — EGP ${fmtEgp(p.amountEgp)}`,
            body: p.actorName ? `${p.title} · ${p.actorName}` : p.title,
          };
    }
    case "product.added": {
      const p = payload as ProductAddedPayload;
      return ar
        ? {
            title: "منتج جديد",
            body: p.actorName ? `${p.productName} · ${p.actorName}` : p.productName,
          }
        : {
            title: "New product",
            body: p.actorName ? `${p.productName} · ${p.actorName}` : p.productName,
          };
    }
    case "inventory.adjusted": {
      const p = payload as InventoryAdjustedPayload;
      const sign = p.deltaQty >= 0 ? "+" : "";
      return ar
        ? {
            title: `تعديل مخزون — ${p.productName}`,
            body: `${sign}${p.deltaQty} · المتاح ${p.newQty}${p.actorName ? ` · ${p.actorName}` : ""}`,
          }
        : {
            title: `Stock adjusted — ${p.productName}`,
            body: `${sign}${p.deltaQty} · on hand ${p.newQty}${p.actorName ? ` · ${p.actorName}` : ""}`,
          };
    }
    case "return.recorded": {
      const p = payload as ReturnRecordedPayload;
      const inv = p.invoiceId ? ` · ${p.invoiceId}` : "";
      const amtAr = p.amountEgp != null ? ` — ${fmtEgp(p.amountEgp)} ج.م` : "";
      const amtEn = p.amountEgp != null ? ` — EGP ${fmtEgp(p.amountEgp)}` : "";
      return ar
        ? {
            title: `مرتجع جديد${amtAr}`,
            body: `${p.actorName ?? ""}${inv}`.trim(),
          }
        : {
            title: `New return${amtEn}`,
            body: `${p.actorName ?? ""}${inv}`.trim(),
          };
    }
    case "attendance.check_in": {
      const p = payload as AttendanceCheckInPayload;
      const d = new Date(p.occurredAt);
      const hhmm = isNaN(d.getTime())
        ? ""
        : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return ar
        ? { title: `${p.employeeName} سجَّل الحضور`, body: hhmm }
        : { title: `${p.employeeName} checked in`, body: hhmm };
    }
    case "purchase.created": {
      const p = payload as PurchaseCreatedPayload;
      return ar
        ? {
            title: `فاتورة شراء جديدة — ${fmtEgp(p.totalEgp)} ج.م`,
            body: `${p.supplierName} · ${p.itemCount} صنف${p.actorName ? ` · ${p.actorName}` : ""}`,
          }
        : {
            title: `Purchase created — EGP ${fmtEgp(p.totalEgp)}`,
            body: `${p.supplierName} · ${p.itemCount} items${p.actorName ? ` · ${p.actorName}` : ""}`,
          };
    }
    case "purchase.returned": {
      const p = payload as PurchaseReturnedPayload;
      return ar
        ? {
            title: `مرتجع شراء — ${p.supplierName}`,
            body: p.reason ?? (p.actorName ?? ""),
          }
        : {
            title: `Purchase return — ${p.supplierName}`,
            body: p.reason ?? (p.actorName ?? ""),
          };
    }
    case "supplier.payment.recorded": {
      const p = payload as SupplierPaymentRecordedPayload;
      const remAr = p.remainingBalanceEgp != null
        ? ` · متبقّي ${fmtEgp(p.remainingBalanceEgp)} ج.م`
        : "";
      const remEn = p.remainingBalanceEgp != null
        ? ` · balance EGP ${fmtEgp(p.remainingBalanceEgp)}`
        : "";
      return ar
        ? {
            title: `دفعة لـ ${p.supplierName} — ${fmtEgp(p.amountEgp)} ج.م`,
            body: `${p.method}${remAr}`,
          }
        : {
            title: `Paid ${p.supplierName} — EGP ${fmtEgp(p.amountEgp)}`,
            body: `${p.method}${remEn}`,
          };
    }
    case "customer.created": {
      const p = payload as CustomerCreatedPayload;
      const name = p.customerName && p.customerName.trim() ? p.customerName.trim() : p.customerPhone;
      const amt = p.firstSaleAmountEgp != null
        ? (ar ? ` · أول بيع ${fmtEgp(p.firstSaleAmountEgp)} ج.م` : ` · first sale EGP ${fmtEgp(p.firstSaleAmountEgp)}`)
        : "";
      return ar
        ? { title: `عميل جديد — ${name}`, body: `${p.customerPhone}${amt}` }
        : { title: `New customer — ${name}`, body: `${p.customerPhone}${amt}` };
    }
    case "expense.voided": {
      const p = payload as ExpenseVoidedPayload;
      return ar
        ? {
            title: `مصروف ملغى — ${fmtEgp(p.amountEgp)} ج.م`,
            body: p.actorName ? `${p.title} · ${p.actorName}` : p.title,
          }
        : {
            title: `Expense voided — EGP ${fmtEgp(p.amountEgp)}`,
            body: p.actorName ? `${p.title} · ${p.actorName}` : p.title,
          };
    }
    case "leave.approved": {
      const p = payload as LeaveApprovedPayload;
      return ar
        ? {
            title: `إجازة ${p.requesterName} معتمدة`,
            body: `${p.dayCount} يوم${p.approverName ? ` · اعتمد ${p.approverName}` : ""}`,
          }
        : {
            title: `Leave approved — ${p.requesterName}`,
            body: `${p.dayCount} day${p.dayCount === 1 ? "" : "s"}${p.approverName ? ` · by ${p.approverName}` : ""}`,
          };
    }
    case "leave.rejected": {
      const p = payload as LeaveRejectedPayload;
      return ar
        ? {
            title: `إجازة ${p.requesterName} مرفوضة`,
            body: p.reason ?? (p.decidedByName ? `قرار ${p.decidedByName}` : ""),
          }
        : {
            title: `Leave rejected — ${p.requesterName}`,
            body: p.reason ?? (p.decidedByName ? `by ${p.decidedByName}` : ""),
          };
    }
    case "payroll.calculated": {
      const p = payload as PayrollCalculatedPayload;
      return ar
        ? { title: `كشف مرتب ${p.employeeName} — ${p.month}`, body: `صافي ${fmtEgp(p.netEgp)} ج.م` }
        : { title: `Payroll draft — ${p.employeeName}`, body: `${p.month} · net EGP ${fmtEgp(p.netEgp)}` };
    }
    case "payroll.finalized": {
      const p = payload as PayrollFinalizedPayload;
      return ar
        ? {
            title: `اعتماد مرتب ${p.employeeName} — ${p.month}`,
            body: `صافي ${fmtEgp(p.netEgp)} ج.م${p.finalizedByName ? ` · ${p.finalizedByName}` : ""}`,
          }
        : {
            title: `Payroll finalized — ${p.employeeName}`,
            body: `${p.month} · net EGP ${fmtEgp(p.netEgp)}${p.finalizedByName ? ` · ${p.finalizedByName}` : ""}`,
          };
    }
    case "payroll.voided": {
      const p = payload as PayrollVoidedPayload;
      return ar
        ? {
            title: `إلغاء اعتماد مرتب ${p.employeeName}`,
            body: `${p.month}${p.voidedByName ? ` · ${p.voidedByName}` : ""}${p.reason ? ` — ${p.reason}` : ""}`,
          }
        : {
            title: `Payroll voided — ${p.employeeName}`,
            body: `${p.month}${p.voidedByName ? ` · ${p.voidedByName}` : ""}${p.reason ? ` — ${p.reason}` : ""}`,
          };
    }
    case "report.daily": {
      const p = payload as ReportPayload;
      const bodyParts: string[] = [p.period];
      if (p.totalRevenueEgp != null)
        bodyParts.push(ar ? `${fmtEgp(p.totalRevenueEgp)} ج.م` : `EGP ${fmtEgp(p.totalRevenueEgp)}`);
      if (p.salesCount != null)
        bodyParts.push(ar ? `${p.salesCount} فاتورة` : `${p.salesCount} sales`);
      return ar
        ? { title: "التقرير اليومي جاهز", body: bodyParts.join(" · ") }
        : { title: "Daily report ready", body: bodyParts.join(" · ") };
    }
    case "attendance.late": {
      const p = payload as AttendanceLatePayload;
      return ar
        ? {
            title: `${p.employeeName} متأخر`,
            body: `${p.lateMinutes} دقيقة تأخير · الموعد ${p.scheduledStart}`,
          }
        : {
            title: `${p.employeeName} is late`,
            body: `${p.lateMinutes} min late · scheduled ${p.scheduledStart}`,
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
      // The collection events (13 §4.4): the in-app title plus the store name.
      return { subject: `${inApp.title}${store}`, text: body };
  }
}
