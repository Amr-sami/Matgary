// Notification Center — event catalog.
//
// Returns the list of notification events the caller can see + configure.
// Visibility is role + permission gated (via visibleEventTypes in
// event-types.ts): collection events only show for admitted tenants,
// payroll events require manage_payroll, attendance.late requires manage_team.
//
// Each catalog entry carries the owner-friendly label (ar/en), the owner's
// SYSTEM default preference, and the current tenant override (if any) so the
// UI can render the three-level resolver state without a second round trip.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { tenantNotificationOverrides } from "@/lib/db/schema";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  DEFAULT_EVENT_PREFERENCE,
  EVENT_LABELS,
  EVENT_RECIPIENT_PERMISSION,
  type NotificationEventType,
  visibleEventTypes,
} from "@/lib/notifications/event-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Category grouping drives the UI sidebar. Order here is the display order
 *  in Settings → Notifications & Automation. */
const CATEGORY_FOR: Record<NotificationEventType, string> = {
  "sale.created": "sales",
  "sale.alert": "sales",
  "return.recorded": "sales",
  "payment.deferred_settled": "sales",
  "purchase.created": "purchases",
  "purchase.received": "purchases",
  "purchase.returned": "purchases",
  "supplier.payment.recorded": "suppliers",
  "inventory.low_stock": "inventory",
  "inventory.adjusted": "inventory",
  "product.added": "inventory",
  "customer.created": "customers",
  "expense.recorded": "financials",
  "expense.voided": "financials",
  "attendance.check_in": "attendance",
  "attendance.late": "attendance",
  "leave.requested": "leave",
  "leave.approved": "leave",
  "leave.rejected": "leave",
  "payroll.calculated": "payroll",
  "payroll.finalized": "payroll",
  "payroll.voided": "payroll",
  "report.daily": "reports",
  "report.weekly": "reports",
  "report.monthly": "reports",
  "collection.pending": "collections",
  "collection.stale": "collections",
  "collection.unmatched_credit": "collections",
  "collection.source_silent": "collections",
  "collection.limit_warning": "collections",
};

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  // Tenant-level overrides for every event, resolved once per request.
  const overrides = await db
    .select({
      eventType: tenantNotificationOverrides.eventType,
      enabled: tenantNotificationOverrides.enabled,
    })
    .from(tenantNotificationOverrides)
    .where(eq(tenantNotificationOverrides.tenantId, r.ctx.tenantId));
  const overrideByEvent = new Map(overrides.map((o) => [o.eventType, o.enabled]));

  // Collection events are gated by the dispatcher's own collectionsAdmitted
  // check at delivery time, so showing them in the catalog is safe — a
  // non-admitted tenant simply never has the dispatcher fire them. The
  // owner's catalog view opts to show everything they're role-eligible for.
  const visible = visibleEventTypes(
    r.ctx.role === "owner" ? "owner" : "staff",
    r.ctx.permissions,
    true,
  );

  const events = visible.map((e) => {
    const ownerDefault = DEFAULT_EVENT_PREFERENCE.owner[e];
    const staffDefault = DEFAULT_EVENT_PREFERENCE.staff[e];
    return {
      eventType: e,
      category: CATEGORY_FOR[e] ?? "other",
      label: EVENT_LABELS[e],
      permission: EVENT_RECIPIENT_PERMISSION[e] ?? null,
      // System default — the "on by default" baseline for a new tenant.
      systemDefault: {
        owner: {
          inApp: ownerDefault.inApp,
          email: ownerDefault.email,
          digestMode: ownerDefault.digestMode,
        },
        staff: {
          inApp: staffDefault.inApp,
          email: staffDefault.email,
          digestMode: staffDefault.digestMode,
        },
      },
      // Tenant override — null when no row; boolean when the owner has
      // explicitly disabled/enabled the event tenant-wide.
      tenantOverride: overrideByEvent.get(e) ?? null,
    };
  });

  return NextResponse.json({
    tenantId: r.ctx.tenantId,
    events,
  });
}
