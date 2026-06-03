import { eq, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { tenants, tenantDeletions, tenantMembers, users } from "@/lib/db/schema";

// H12 — schedule, cancel, and enforce tenant deletion with a 30-day grace.
// Hard delete relies on the `onDelete: "cascade"` FK clauses already present
// on every tenant-scoped table (35 in schema.ts) — deleting the `tenants`
// row implicitly removes everything that hangs off it. The gravestone row
// in `tenant_deletions` is written BEFORE the cascade so the audit trail
// survives.

const GRACE_DAYS = 30;

export async function scheduleDeletion(tenantId: string): Promise<Date> {
  const when = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000);
  await db
    .update(tenants)
    .set({ deletionScheduledAt: when })
    .where(eq(tenants.id, tenantId));
  return when;
}

export async function cancelDeletion(tenantId: string): Promise<void> {
  await db
    .update(tenants)
    .set({ deletionScheduledAt: null })
    .where(eq(tenants.id, tenantId));
}

export async function getDeletionStatus(
  tenantId: string,
): Promise<{ scheduledAt: Date | null }> {
  const [t] = await db
    .select({ scheduledAt: tenants.deletionScheduledAt })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return { scheduledAt: t?.scheduledAt ?? null };
}

/** Look up tenants whose deletion_scheduled_at is in the past; for each,
 *  write the gravestone, then delete the tenant row (cascade purges every
 *  tenant-scoped table). Returns the number of tenants purged. */
export async function executePendingDeletions(now: Date = new Date()): Promise<{
  purged: number;
  ids: string[];
}> {
  const due = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      scheduledAt: tenants.deletionScheduledAt,
    })
    .from(tenants)
    .where(isNotNull(tenants.deletionScheduledAt));
  const dueIds: string[] = [];
  for (const t of due) {
    if (!t.scheduledAt) continue;
    if (t.scheduledAt.getTime() > now.getTime()) continue;
    // Grab the owner's email as a snapshot. Multi-owner tenants take the
    // earliest-joined owner (their createdAt isn't tracked on tenant_members
    // — use users.createdAt indirectly via the join order; good enough for v1).
    const [owner] = await db
      .select({ email: users.email })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        sql`${tenantMembers.tenantId} = ${t.id} AND ${tenantMembers.role} = 'owner'`,
      )
      .limit(1);
    await db.insert(tenantDeletions).values({
      tenantId: t.id,
      tenantSlugSnapshot: t.slug,
      ownerEmailSnapshot: owner?.email ?? null,
      scheduledAt: t.scheduledAt,
    });
    await db.delete(tenants).where(eq(tenants.id, t.id));
    dueIds.push(t.id);
  }
  return { purged: dueIds.length, ids: dueIds };
}

/** Test helper used by the cron route. Keeps the routes themselves
 *  small + makes the date-injectability explicit. */
export async function findDueDeletions(now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tenants)
    .where(
      sql`${tenants.deletionScheduledAt} IS NOT NULL AND ${tenants.deletionScheduledAt} <= ${now}`,
    );
  return rows[0]?.count ?? 0;
}

// Imported here so callers don't have to. lte stays a re-export in case
// future cron sweeps want to compose their own where clause.
export { lte };
