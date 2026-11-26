// Tenant queries for /admin/*. All run through the BYPASSRLS pool — admin
// reads see every tenant in one query without setting `app.tenant_id`. Spec
// 02 says: never call withTenant() from here; that would silently scope us
// away from data we need.

import {
  and,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  not,
  or,
  sql,
} from "drizzle-orm";
import {
  activityLogs,
  branches,
  paymentAttempts,
  sales,
  subscriptions,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { getAdminDb } from "./db";

export type TenantStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired"
  | "suspended";

export interface TenantListRow {
  id: string;
  name: string;
  slug: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  plan: string | null;
  status: TenantStatus;
  trialEndsAt: Date | null;
  branchCount: number;
  employeeCount: number;
  lastSaleAt: Date | null;
  mrr: string; // monthly recurring revenue contribution (EGP, string)
  createdAt: Date;
  suspendedAt: Date | null;
}

export interface TenantListFilters {
  status?: TenantStatus;
  plan?: string;
  branchCount?: "1" | "2-3" | "4+";
  trialExpiringInDays?: number;
  q?: string;
  sort?: "created_at" | "last_login" | "mrr";
  limit?: number;
  offset?: number;
}

export interface TenantDetailPayload {
  tenant: {
    id: string;
    name: string;
    slug: string;
    createdAt: Date;
    suspendedAt: Date | null;
    suspendedReason: string | null;
    deletionScheduledAt: Date | null;
  };
  owner: {
    userId: string;
    name: string | null;
    email: string;
    phone: string | null;
  } | null;
  subscription: {
    plan: string;
    status: TenantStatus;
    trialEndsAt: Date;
    currentPeriodEndsAt: Date | null;
    cancelledAt: Date | null;
    amountEgp: string | null;
  } | null;
  lastPayment: {
    amountEgp: string;
    status: string;
    attemptedAt: Date;
    failureReason: string | null;
  } | null;
  failedAttempts90d: number;
  branches: {
    id: string;
    name: string;
    isActive: boolean;
    employeeCount: number;
    lastSaleAt: Date | null;
  }[];
  counts: {
    employees: number;
    branches: number;
    salesLast30d: number;
  };
  /** Resolved status, derived: tenants.suspended_at wins over subscriptions.status. */
  resolvedStatus: TenantStatus;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Project tenant + subscription rows into a single resolved status. Suspended
 *  always wins (operationally a tenant is paused regardless of billing). */
export function resolveTenantStatus(
  suspendedAt: Date | null,
  subStatus: string | null,
): TenantStatus {
  if (suspendedAt) return "suspended";
  switch (subStatus) {
    case "trialing":
    case "active":
    case "past_due":
    case "cancelled":
    case "expired":
      return subStatus;
    default:
      // Tenant exists but no subscription row yet — should be impossible after
      // onboarding; treat as trialing so the list page surfaces it for triage.
      return "trialing";
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────

/** Resolve the "owner" of a tenant. There can be more than one (multi-owner
 *  tenants) — we pick the earliest joined owner-role member. */
async function ownerRowsFor(
  tenantIds: string[],
): Promise<Map<string, { userId: string; name: string | null; email: string; phone: string | null }>> {
  const db = getAdminDb();
  const map = new Map<string, { userId: string; name: string | null; email: string; phone: string | null }>();
  if (tenantIds.length === 0) return map;
  const rows = await db
    .select({
      tenantId: tenantMembers.tenantId,
      userId: users.id,
      name: users.name,
      email: users.email,
      phone: tenantMembers.phone,
      joinedAt: tenantMembers.joinedAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(
      and(
        eq(tenantMembers.role, "owner"),
        inArray(tenantMembers.tenantId, tenantIds),
      ),
    );
  // Earliest-joined wins when multiple owners exist.
  rows.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  for (const r of rows) {
    if (!map.has(r.tenantId)) {
      map.set(r.tenantId, {
        userId: r.userId,
        name: r.name,
        email: r.email,
        phone: r.phone,
      });
    }
  }
  return map;
}

export async function listTenants(
  filters: TenantListFilters = {},
): Promise<TenantListRow[]> {
  const db = getAdminDb();
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  // Step 1 — pull base tenants matching the filters that are cheap on the
  // tenants table itself (status / plan / search / trial expiring).
  const conditions = [] as ReturnType<typeof and>[];

  if (filters.q && filters.q.trim()) {
    const q = `%${filters.q.trim()}%`;
    // Search tenant name OR slug. Owner email + phone matched via subquery
    // below.
    const ownerMatchTenantIds = db
      .select({ tenantId: tenantMembers.tenantId })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        and(
          eq(tenantMembers.role, "owner"),
          or(
            ilike(users.email, q),
            ilike(tenantMembers.phone, q),
            ilike(users.name, q),
          )!,
        ),
      );
    const orClause = or(
      ilike(tenants.name, q),
      ilike(tenants.slug, q),
      inArray(tenants.id, ownerMatchTenantIds),
    );
    if (orClause) conditions.push(orClause as unknown as ReturnType<typeof and>);
  }

  if (filters.status === "suspended") {
    conditions.push(not(isNull(tenants.suspendedAt)) as unknown as ReturnType<typeof and>);
  } else if (filters.status) {
    conditions.push(
      and(
        isNull(tenants.suspendedAt),
        eq(subscriptions.status, filters.status),
      ) as unknown as ReturnType<typeof and>,
    );
  }

  if (filters.plan) {
    conditions.push(eq(subscriptions.plan, filters.plan) as unknown as ReturnType<typeof and>);
  }

  if (filters.trialExpiringInDays && filters.trialExpiringInDays > 0) {
    const cutoff = new Date(
      Date.now() + filters.trialExpiringInDays * 24 * 60 * 60 * 1000,
    );
    conditions.push(
      and(
        eq(subscriptions.status, "trialing"),
        gt(subscriptions.trialEndsAt, new Date()),
        lt(subscriptions.trialEndsAt, cutoff),
      ) as unknown as ReturnType<typeof and>,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const baseRows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      createdAt: tenants.createdAt,
      suspendedAt: tenants.suspendedAt,
      plan: subscriptions.plan,
      subStatus: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
      amountEgp: subscriptions.amountEgp,
    })
    .from(tenants)
    .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
    .where(where)
    .orderBy(desc(tenants.createdAt))
    .limit(limit)
    .offset(offset);

  if (baseRows.length === 0) return [];
  const tenantIds = baseRows.map((r) => r.id);

  // Step 2 — fan-out aggregates in parallel.
  const [ownerMap, branchCountRows, employeeCountRows, lastSaleRows] = await Promise.all([
    ownerRowsFor(tenantIds),
    db
      .select({
        tenantId: branches.tenantId,
        count: sql<number>`count(*) filter (where ${branches.isActive} = true)::int`,
      })
      .from(branches)
      .where(inArray(branches.tenantId, tenantIds))
      .groupBy(branches.tenantId),
    db
      .select({
        tenantId: tenantMembers.tenantId,
        count: sql<number>`count(distinct ${tenantMembers.userId})::int`,
      })
      .from(tenantMembers)
      .where(inArray(tenantMembers.tenantId, tenantIds))
      .groupBy(tenantMembers.tenantId),
    db
      .select({
        tenantId: sales.tenantId,
        lastSaleAt: sql<Date>`max(${sales.saleDate})`,
      })
      .from(sales)
      .where(inArray(sales.tenantId, tenantIds))
      .groupBy(sales.tenantId),
  ]);

  const branchCount = new Map(branchCountRows.map((r) => [r.tenantId, r.count]));
  const employeeCount = new Map(employeeCountRows.map((r) => [r.tenantId, r.count]));
  const lastSale = new Map(lastSaleRows.map((r) => [r.tenantId, r.lastSaleAt]));

  let projected = baseRows.map<TenantListRow>((r) => {
    const owner = ownerMap.get(r.id);
    const resolved = resolveTenantStatus(r.suspendedAt, r.subStatus);
    const mrr =
      resolved === "active" && r.amountEgp ? r.amountEgp : "0";
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      ownerPhone: owner?.phone ?? null,
      plan: r.plan ?? null,
      status: resolved,
      trialEndsAt: r.trialEndsAt ?? null,
      branchCount: branchCount.get(r.id) ?? 0,
      employeeCount: employeeCount.get(r.id) ?? 0,
      lastSaleAt: lastSale.get(r.id) ?? null,
      mrr,
      createdAt: r.createdAt,
      suspendedAt: r.suspendedAt,
    };
  });

  // Branch-count bucket filter — done in JS to keep the SQL simple.
  if (filters.branchCount) {
    projected = projected.filter((r) => {
      if (filters.branchCount === "1") return r.branchCount <= 1;
      if (filters.branchCount === "2-3") return r.branchCount >= 2 && r.branchCount <= 3;
      return r.branchCount >= 4;
    });
  }

  if (filters.sort === "mrr") {
    projected.sort((a, b) => Number(b.mrr) - Number(a.mrr));
  } else if (filters.sort === "last_login") {
    projected.sort((a, b) => {
      const av = a.lastSaleAt?.getTime() ?? 0;
      const bv = b.lastSaleAt?.getTime() ?? 0;
      return bv - av;
    });
  }

  return projected;
}

export async function getTenantDetail(
  tenantId: string,
): Promise<TenantDetailPayload | null> {
  const db = getAdminDb();
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) return null;

  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);

  const ownerMap = await ownerRowsFor([tenantId]);
  const owner = ownerMap.get(tenantId);

  // Last payment of any status (gives a picture of "is this tenant
  // actually transacting?").
  const [lastPayment] = await db
    .select({
      amountEgp: paymentAttempts.amountEgp,
      status: paymentAttempts.status,
      attemptedAt: paymentAttempts.attemptedAt,
      failureReason: paymentAttempts.failureReason,
    })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.tenantId, tenantId))
    .orderBy(desc(paymentAttempts.attemptedAt))
    .limit(1);

  // Failed attempts in the last 90 days.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [failedCount] = await db
    .select({
      count: sql<number>`coalesce(count(*), 0)::int`,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.tenantId, tenantId),
        eq(paymentAttempts.status, "failed"),
        gt(paymentAttempts.attemptedAt, ninetyDaysAgo),
      ),
    );

  // Branches + employee counts + last-sale per branch, in two queries.
  const branchRows = await db
    .select({
      id: branches.id,
      name: branches.name,
      isActive: branches.isActive,
    })
    .from(branches)
    .where(eq(branches.tenantId, tenantId))
    .orderBy(branches.name);

  const branchIds = branchRows.map((b) => b.id);
  const [employeeCountByBranch, lastSaleByBranch] = await Promise.all([
    branchIds.length === 0
      ? Promise.resolve([] as { branchId: string; count: number }[])
      : db
          .select({
            branchId: tenantMembers.branchId,
            count: sql<number>`count(distinct ${tenantMembers.userId})::int`,
          })
          .from(tenantMembers)
          .where(
            and(
              eq(tenantMembers.tenantId, tenantId),
              inArray(tenantMembers.branchId, branchIds),
            ),
          )
          .groupBy(tenantMembers.branchId),
    branchIds.length === 0
      ? Promise.resolve([] as { branchId: string; lastSaleAt: Date | null }[])
      : db
          .select({
            branchId: sales.branchId,
            lastSaleAt: sql<Date>`max(${sales.saleDate})`,
          })
          .from(sales)
          .where(
            and(
              eq(sales.tenantId, tenantId),
              inArray(sales.branchId, branchIds),
            ),
          )
          .groupBy(sales.branchId),
  ]);
  const empByBranch = new Map(
    employeeCountByBranch.map((r) => [r.branchId, r.count]),
  );
  const saleByBranch = new Map(
    lastSaleByBranch.map((r) => [r.branchId, r.lastSaleAt]),
  );

  // Top-level counts.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [employeesAgg, salesAgg] = await Promise.all([
    db
      .select({ count: sql<number>`count(distinct ${tenantMembers.userId})::int` })
      .from(tenantMembers)
      .where(eq(tenantMembers.tenantId, tenantId)),
    db
      .select({ count: sql<number>`coalesce(count(*), 0)::int` })
      .from(sales)
      .where(and(eq(sales.tenantId, tenantId), gt(sales.saleDate, thirtyDaysAgo))),
  ]);

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      createdAt: tenant.createdAt,
      suspendedAt: tenant.suspendedAt,
      suspendedReason: tenant.suspendedReason,
      deletionScheduledAt: tenant.deletionScheduledAt,
    },
    owner: owner
      ? {
          userId: owner.userId,
          name: owner.name,
          email: owner.email,
          phone: owner.phone,
        }
      : null,
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: resolveTenantStatus(tenant.suspendedAt, subscription.status),
          trialEndsAt: subscription.trialEndsAt,
          currentPeriodEndsAt: subscription.currentPeriodEndsAt,
          cancelledAt: subscription.cancelledAt,
          amountEgp: subscription.amountEgp,
        }
      : null,
    lastPayment: lastPayment
      ? {
          amountEgp: lastPayment.amountEgp,
          status: lastPayment.status,
          attemptedAt: lastPayment.attemptedAt,
          failureReason: lastPayment.failureReason,
        }
      : null,
    failedAttempts90d: failedCount?.count ?? 0,
    branches: branchRows.map((b) => ({
      id: b.id,
      name: b.name,
      isActive: b.isActive,
      employeeCount: empByBranch.get(b.id) ?? 0,
      lastSaleAt: saleByBranch.get(b.id) ?? null,
    })),
    counts: {
      employees: employeesAgg[0]?.count ?? 0,
      branches: branchRows.length,
      salesLast30d: salesAgg[0]?.count ?? 0,
    },
    resolvedStatus: resolveTenantStatus(
      tenant.suspendedAt,
      subscription?.status ?? null,
    ),
  };
}

export async function listTenantEmployees(tenantId: string) {
  const db = getAdminDb();
  return db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      displayName: tenantMembers.displayName,
      phone: tenantMembers.phone,
      role: tenantMembers.role,
      branchId: tenantMembers.branchId,
      joinedAt: tenantMembers.joinedAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(eq(tenantMembers.tenantId, tenantId))
    .orderBy(tenantMembers.joinedAt);
}

export async function listTenantActivity(tenantId: string, limit = 50) {
  const db = getAdminDb();
  return db
    .select({
      id: activityLogs.id,
      actorName: activityLogs.actorName,
      action: activityLogs.action,
      category: activityLogs.category,
      entityType: activityLogs.entityType,
      entityLabel: activityLogs.entityLabel,
      createdAt: activityLogs.createdAt,
      metadata: activityLogs.metadata,
    })
    .from(activityLogs)
    .where(eq(activityLogs.tenantId, tenantId))
    .orderBy(desc(activityLogs.createdAt))
    .limit(limit);
}
