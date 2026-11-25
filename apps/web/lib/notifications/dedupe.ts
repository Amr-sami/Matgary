// Cron-fanout idempotency.
//
// The scheduled jobs (reports-tick, low-stock sweep, supplier-due sweep,
// attendance-late sweep) can fire more than once — a cron scheduler retry,
// a rate-limited retry, or an operator re-run. The dedupe key is derived
// deterministically from (tenant, userId, kind, link) where `link` embeds
// the period/date identifier the producer chose — e.g. report pushes use
// `/reports/weekly?period=2026-W47`, low-stock uses
// `/inventory?lowStockDate=2026-11-17`. Two runs with the same inputs
// therefore collide on the same (tenant, userId, kind, link) row and the
// second run skips before fanoutEvent writes anything.
//
// Backed by the existing notifications table + notifications_tenant_user_idx
// so the lookup is bounded index-scan per recipient. No new table required.

import { and, eq, gte } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import type { NotificationKind } from "@/lib/repo/notifications";

export interface DedupeKey {
  tenantId: string;
  userId: string;
  kind: NotificationKind;
  /** Full `link` column value. Must include the period/date for uniqueness
   *  (e.g. "/reports/weekly?period=2026-W47"). */
  link: string;
  /** Lower bound on created_at so we don't scan the whole table. Pass the
   *  period's start timestamp — anything older is irrelevant. */
  since: Date;
}

/** True when a notification matching `key` is already in the table. */
export async function wasAlreadyDispatched(key: DedupeKey): Promise<boolean> {
  const rows = await withTenant(key.tenantId, (tx) =>
    tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, key.tenantId),
          eq(notifications.userId, key.userId),
          eq(notifications.kind, key.kind),
          eq(notifications.link, key.link),
          gte(notifications.createdAt, key.since),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

/** Owner user-ids for a tenant. Cron jobs target owners by default — the
 *  dispatcher's own role gate (EVENT_RECIPIENT_ROLES) still applies when
 *  fanoutEvent runs, but the dedupe check needs to know who to query up
 *  front. */
export async function listOwnerUserIds(tenantId: string): Promise<string[]> {
  const { tenantMembers } = await import("@/lib/db/schema");
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, "owner"))),
  );
  return rows.map((r) => r.userId);
}
