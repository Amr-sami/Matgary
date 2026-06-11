import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { activityLogs, tenantMembers, tenants, users } from "@/lib/db/schema";
import type { ActivityLogRow } from "@/lib/db/schema";
import type { ActivityCategory } from "@/lib/activity-labels";

export type { ActivityCategory } from "@/lib/activity-labels";
export {
  ACTION_LABELS,
  CATEGORY_LABELS,
  ACTIVITY_CATEGORIES,
} from "@/lib/activity-labels";

export interface LogActivityInput {
  tenantId: string;
  actorUserId: string | null;
  /** Snapshot of actor's name. Helper does a lookup if omitted. */
  actorName?: string | null;
  action: string;
  category: ActivityCategory;
  entityType?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  /** Branch the action happened at, when applicable. Pure context — never a gate. */
  branchId?: string | null;
}

/**
 * Insert an activity-log row. Fire-and-forget — any error is logged to the
 * server console and swallowed, so an audit failure cannot break the parent
 * mutation. Callers don't need to await this for correctness; awaiting is
 * fine if you want to be sure the row is written before responding.
 */
/**
 * Delete activity-log rows older than `cutoff` for a single tenant, in
 * chunked batches so a long purge doesn't hold a wide lock. Runs inside
 * `withTenant` so the existing RLS policy is the gate — we never touch
 * another tenant's rows even if the caller passed the wrong id.
 *
 * Returns the number of rows deleted for that tenant.
 */
export async function pruneTenantActivity(
  tenantId: string,
  cutoff: Date,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ deleted: number }> {
  const batchSize = Math.max(100, Math.min(50_000, options.batchSize ?? 10_000));
  const maxBatches = Math.max(1, options.maxBatches ?? 50);
  let total = 0;
  await withTenant(tenantId, async (tx) => {
    for (let i = 0; i < maxBatches; i += 1) {
      // Select-then-delete by primary key so the affected-row count is
      // unambiguous (postgres-js's affected-row count surface differs across
      // driver versions; this avoids relying on it).
      const rows = await tx
        .select({ id: activityLogs.id })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.tenantId, tenantId),
            lt(activityLogs.createdAt, cutoff),
          ),
        )
        .limit(batchSize);
      if (rows.length === 0) break;
      await tx
        .delete(activityLogs)
        .where(
          and(
            eq(activityLogs.tenantId, tenantId),
            inArray(
              activityLogs.id,
              rows.map((r) => r.id),
            ),
          ),
        );
      total += rows.length;
      if (rows.length < batchSize) break;
    }
  });
  return { deleted: total };
}

/**
 * Sweep the activity-log retention prune across every tenant. Returns
 * per-tenant counts; failures on a single tenant don't abort the sweep.
 */
export async function pruneActivityAllTenants(
  cutoff: Date,
  options?: { batchSize?: number; maxBatches?: number },
): Promise<{
  totalDeleted: number;
  tenants: number;
  failures: number;
}> {
  const { db } = await import("@/lib/db");
  const rows = await db.select({ id: tenants.id }).from(tenants);
  let totalDeleted = 0;
  let failures = 0;
  for (const t of rows) {
    try {
      const { deleted } = await pruneTenantActivity(t.id, cutoff, options);
      totalDeleted += deleted;
    } catch (err) {
      failures += 1;
      console.error(
        `[activity/prune] tenant ${t.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { totalDeleted, tenants: rows.length, failures };
}

export async function logActivity(input: LogActivityInput): Promise<void> {
  try {
    let actorName = input.actorName ?? null;
    // Spec 07 — when the current request is an impersonation session,
    // every activity row picks up an `impersonatedBy` marker in metadata.
    // Best-effort: silently skip when there's no active request / session.
    let metadata = input.metadata ?? null;
    try {
      const { auth } = await import("@/lib/auth");
      const session = await auth();
      if (session && session.impersonation) {
        metadata = {
          ...(metadata ?? {}),
          impersonatedBy: session.impersonation.adminId,
          impersonatedByEmail: session.impersonation.adminEmail,
        };
      }
    } catch {
      // No request context (e.g. cron-driven write) — leave metadata alone.
    }
    await withTenant(input.tenantId, async (tx) => {
      if (!actorName && input.actorUserId) {
        const [member] = await tx
          .select({ displayName: tenantMembers.displayName })
          .from(tenantMembers)
          .where(
            and(
              eq(tenantMembers.tenantId, input.tenantId),
              eq(tenantMembers.userId, input.actorUserId),
            ),
          )
          .limit(1);
        actorName = member?.displayName ?? null;
        if (!actorName) {
          const [u] = await tx
            .select({ name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, input.actorUserId))
            .limit(1);
          actorName = u?.name ?? u?.email ?? null;
        }
      }
      await tx.insert(activityLogs).values({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorName,
        action: input.action,
        category: input.category,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        entityLabel: input.entityLabel ?? null,
        metadata,
        ip: input.ip ?? null,
        branchId: input.branchId ?? null,
      });
    });
  } catch (err) {
    console.error("[activity] log insert failed", err);
  }
}

export interface ListActivityFilters {
  /** Inclusive lower bound. */
  from?: Date;
  /** Inclusive upper bound. */
  to?: Date;
  actorUserId?: string;
  category?: ActivityCategory;
  /** Hard cap; the page paginates with `before` (createdAt) for keyset paging. */
  limit?: number;
  /** Keyset cursor — return rows strictly older than this. */
  before?: Date;
}

export interface ActivityListItem {
  id: string;
  action: string;
  category: string;
  actorUserId: string | null;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export async function listActivity(
  tenantId: string,
  filters: ListActivityFilters = {},
): Promise<ActivityListItem[]> {
  const limit = Math.min(filters.limit ?? 50, 200);
  return withTenant(tenantId, async (tx) => {
    const where = [eq(activityLogs.tenantId, tenantId)];
    if (filters.from) where.push(gte(activityLogs.createdAt, filters.from));
    if (filters.to) where.push(lte(activityLogs.createdAt, filters.to));
    if (filters.actorUserId)
      where.push(eq(activityLogs.actorUserId, filters.actorUserId));
    if (filters.category) where.push(eq(activityLogs.category, filters.category));
    if (filters.before) where.push(sql`${activityLogs.createdAt} < ${filters.before}`);

    const rows = (await tx
      .select()
      .from(activityLogs)
      .where(and(...where))
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit)) as ActivityLogRow[];

    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      category: r.category,
      actorUserId: r.actorUserId,
      actorName: r.actorName,
      entityType: r.entityType,
      entityId: r.entityId,
      entityLabel: r.entityLabel,
      metadata: r.metadata,
      createdAt: r.createdAt,
    }));
  });
}

/** Distinct list of actors that show up in the log, for the filter dropdown. */
export async function listActivityActors(
  tenantId: string,
): Promise<{ userId: string; name: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .selectDistinctOn([activityLogs.actorUserId], {
        userId: activityLogs.actorUserId,
        name: activityLogs.actorName,
      })
      .from(activityLogs)
      .where(eq(activityLogs.tenantId, tenantId));
    return rows
      .filter((r): r is { userId: string; name: string | null } =>
        r.userId !== null,
      )
      .map((r) => ({ userId: r.userId, name: r.name ?? "—" }));
  });
}
