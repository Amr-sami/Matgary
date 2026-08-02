// Smoke test for the v1 notification dispatcher. Fires one event per event
// type against a live tenant, then reads back the resulting notification
// rows + digest queue entries so we can eyeball the fanout is producing the
// right in-app + email side-effects.
//
// Run with:
//   TENANT_ID=<uuid> pnpm tsx scripts/smoke-notifications.ts

import "dotenv/config";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import {
  branches as branchesTable,
  notificationDigestQueue,
  notifications,
  tenantMembers,
  tenants,
} from "@/lib/db/schema";
import { fanoutEvent } from "@/lib/notifications/dispatch";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/notifications/event-types";

async function main() {
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) {
    throw new Error("Set TENANT_ID to a real tenant uuid before running.");
  }

  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  console.log(`Smoke-testing tenant: ${tenant.name} (${tenant.id})`);

  const owner = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          eq(tenantMembers.role, "owner"),
        ),
      )
      .limit(1);
    return rows[0]?.userId ?? null;
  });
  if (!owner) throw new Error("Tenant has no owner");

  const [branch] = await withTenant(tenantId, async (tx) =>
    tx
      .select({ id: branchesTable.id, name: branchesTable.name })
      .from(branchesTable)
      .where(eq(branchesTable.tenantId, tenantId))
      .limit(1),
  );
  const branchId = branch?.id ?? null;
  const branchName = branch?.name ?? "Main";

  console.log(`Owner: ${owner}, Branch: ${branchName} (${branchId})`);

  // Baselines so we count only rows added by this run.
  const before = await withTenant(tenantId, async (tx) => {
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(eq(notifications.tenantId, tenantId));
    const [{ q }] = await tx
      .select({ q: sql<number>`count(*)::int` })
      .from(notificationDigestQueue)
      .where(
        and(
          eq(notificationDigestQueue.tenantId, tenantId),
          isNull(notificationDigestQueue.sentAt),
        ),
      );
    return { notif: n, digest: q };
  });

  console.log(
    `Baseline: notifications=${before.notif}, unsent digest=${before.digest}`,
  );

  // Fire one of each event type.
  await fanoutEvent(tenantId, branchId, "sale.created", {
    invoiceId: "SMK-INV-1",
    totalEgp: 250,
    lineCount: 2,
    branchName,
    link: "/sales",
    actorUserId: null,
  });
  await fanoutEvent(tenantId, branchId, "purchase.received", {
    poShortId: "smk-po-1",
    supplierName: "Smoke Supplier",
    totalEgp: 1200,
    itemCount: 4,
    branchName,
    link: "/purchases",
    actorUserId: null,
  });
  await fanoutEvent(tenantId, branchId, "inventory.low_stock", {
    productName: "Smoke SKU",
    remainingQty: 2,
    threshold: 3,
    branchName,
    link: "/inventory",
    actorUserId: null,
  });
  await fanoutEvent(tenantId, branchId, "payment.deferred_settled", {
    customerName: "Smoke Customer",
    amountEgp: 500,
    invoicesSettled: 1,
    newBalanceEgp: 0,
    link: "/customers",
    actorUserId: null,
  });
  await fanoutEvent(tenantId, branchId, "leave.requested", {
    requesterName: "Smoke Staff",
    dayCount: 3,
    link: "/leave",
    actorUserId: null,
  });

  // Give the fire-and-forget internals a tick to settle.
  await new Promise((r) => setTimeout(r, 500));

  const after = await withTenant(tenantId, async (tx) => {
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(eq(notifications.tenantId, tenantId));
    const [{ q }] = await tx
      .select({ q: sql<number>`count(*)::int` })
      .from(notificationDigestQueue)
      .where(
        and(
          eq(notificationDigestQueue.tenantId, tenantId),
          isNull(notificationDigestQueue.sentAt),
        ),
      );
    const latest = await tx
      .select({
        kind: notifications.kind,
        title: notifications.title,
        body: notifications.body,
        userId: notifications.userId,
      })
      .from(notifications)
      .where(eq(notifications.tenantId, tenantId))
      .orderBy(desc(notifications.createdAt))
      .limit(NOTIFICATION_EVENT_TYPES.length);
    const queuedRows = await tx
      .select({
        eventType: notificationDigestQueue.eventType,
        userId: notificationDigestQueue.userId,
      })
      .from(notificationDigestQueue)
      .where(
        and(
          eq(notificationDigestQueue.tenantId, tenantId),
          isNull(notificationDigestQueue.sentAt),
        ),
      )
      .orderBy(desc(notificationDigestQueue.createdAt))
      .limit(NOTIFICATION_EVENT_TYPES.length);
    return { notif: n, digest: q, latest, queuedRows };
  });

  console.log(
    `After: notifications=${after.notif} (Δ${after.notif - before.notif}), unsent digest=${after.digest} (Δ${after.digest - before.digest})`,
  );

  console.log("\nMost recent notification rows:");
  for (const r of after.latest) {
    console.log(`  [${r.kind}] ${r.title}${r.body ? ` — ${r.body}` : ""}`);
  }
  console.log("\nMost recent queued digest rows:");
  for (const r of after.queuedRows) {
    console.log(`  [${r.eventType}] user=${r.userId}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
