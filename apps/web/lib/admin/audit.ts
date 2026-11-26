// Audit logger. Every admin write path calls logAuditEvent. Fire-and-forget
// is NOT acceptable here — we await the insert so a write that succeeded but
// failed to audit gets rolled back together. Callers wrap business write +
// audit insert in one transaction whenever possible.
//
// Read helpers for /admin/audit (Spec 08) live in the same module; they're
// thin wrappers around the GIN trigram index added by migration 0036.

import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { adminAuditLog, admins } from "@/lib/db/schema";
import { getAdminDb } from "./db";

export interface AuditEventInput {
  adminId: string;
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** Insert one audit row. Returns the new row id so tests can assert. */
export async function logAuditEvent(input: AuditEventInput): Promise<{ id: string }> {
  const db = getAdminDb();
  const [row] = await db
    .insert(adminAuditLog)
    .values({
      adminId: input.adminId,
      action: input.action,
      targetKind: input.targetKind ?? null,
      targetId: input.targetId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      beforeJsonb: input.before ?? null,
      afterJsonb: input.after ?? null,
    })
    .returning({ id: adminAuditLog.id });
  return { id: row.id };
}

// ─── Reads ───────────────────────────────────────────────────────────────

export interface AuditRow {
  id: string;
  adminId: string | null;
  adminEmail: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  beforeJsonb: Record<string, unknown> | null;
  afterJsonb: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface AuditFilters {
  actorAdminId?: string;
  /** Action prefix match: 'tenant.' returns all `tenant.*` rows. */
  actionPrefix?: string;
  targetKind?: string;
  targetId?: string;
  /** Free-text on the union of before/after JSON text. */
  q?: string;
  since?: Date;
  until?: Date;
  /** Cursor encodes the previous page's last (occurredAt, id) tuple. */
  cursor?: string | null;
  limit?: number;
}

export interface AuditPage {
  data: AuditRow[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ o: occurredAt.toISOString(), i: id }),
  ).toString("base64url");
}

function decodeCursor(
  cursor: string,
): { occurredAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { o: string; i: string };
    return { occurredAt: new Date(parsed.o), id: parsed.i };
  } catch {
    return null;
  }
}

export async function listAuditRows(filters: AuditFilters): Promise<AuditPage> {
  const db = getAdminDb();
  const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));
  const conditions: ReturnType<typeof eq>[] = [];

  if (filters.actorAdminId) {
    conditions.push(eq(adminAuditLog.adminId, filters.actorAdminId));
  }
  if (filters.actionPrefix && filters.actionPrefix.trim()) {
    // Drizzle's like operator + parameter binding. Match `prefix%`.
    const prefix = filters.actionPrefix.trim();
    conditions.push(
      sql`${adminAuditLog.action} LIKE ${prefix + "%"}` as unknown as ReturnType<typeof eq>,
    );
  }
  if (filters.targetKind) {
    conditions.push(eq(adminAuditLog.targetKind, filters.targetKind));
  }
  if (filters.targetId) {
    conditions.push(eq(adminAuditLog.targetId, filters.targetId));
  }
  if (filters.since) {
    conditions.push(gte(adminAuditLog.occurredAt, filters.since));
  }
  if (filters.until) {
    conditions.push(lte(adminAuditLog.occurredAt, filters.until));
  }
  if (filters.q && filters.q.trim().length >= 3) {
    const q = filters.q.trim();
    // pg_trgm + GIN matches on the concatenated text view of both diff
    // columns. The expression is identical to the one indexed in migration
    // 0036 so the planner can use it.
    conditions.push(
      sql`(coalesce(${adminAuditLog.beforeJsonb}::text, '') || ' ' || coalesce(${adminAuditLog.afterJsonb}::text, '')) ILIKE ${"%" + q + "%"}` as unknown as ReturnType<typeof eq>,
    );
  }
  if (filters.cursor) {
    const cur = decodeCursor(filters.cursor);
    if (cur) {
      // Keyset pagination: rows older than the cursor's (occurredAt, id).
      conditions.push(
        sql`(${adminAuditLog.occurredAt}, ${adminAuditLog.id}::text) < (${cur.occurredAt.toISOString()}::timestamptz, ${cur.id})` as unknown as ReturnType<typeof eq>,
      );
    }
  }

  const rows = await db
    .select({
      id: adminAuditLog.id,
      adminId: adminAuditLog.adminId,
      adminEmail: admins.email,
      action: adminAuditLog.action,
      targetKind: adminAuditLog.targetKind,
      targetId: adminAuditLog.targetId,
      ip: adminAuditLog.ip,
      userAgent: adminAuditLog.userAgent,
      beforeJsonb: adminAuditLog.beforeJsonb,
      afterJsonb: adminAuditLog.afterJsonb,
      occurredAt: adminAuditLog.occurredAt,
    })
    .from(adminAuditLog)
    .leftJoin(admins, eq(admins.id, adminAuditLog.adminId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(adminAuditLog.occurredAt), desc(adminAuditLog.id))
    .limit(limit + 1);

  // Take limit + 1 so we know whether there's another page.
  const data: AuditRow[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    adminId: r.adminId,
    adminEmail: r.adminEmail ?? null,
    action: r.action,
    targetKind: r.targetKind,
    targetId: r.targetId,
    ip: r.ip,
    userAgent: r.userAgent,
    beforeJsonb: (r.beforeJsonb ?? null) as Record<string, unknown> | null,
    afterJsonb: (r.afterJsonb ?? null) as Record<string, unknown> | null,
    occurredAt: r.occurredAt,
  }));
  const last = data[data.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor(last.occurredAt, last.id) : null;
  return { data, nextCursor };
}

export async function getAuditRow(id: string): Promise<AuditRow | null> {
  const db = getAdminDb();
  const rows = await db
    .select({
      id: adminAuditLog.id,
      adminId: adminAuditLog.adminId,
      adminEmail: admins.email,
      action: adminAuditLog.action,
      targetKind: adminAuditLog.targetKind,
      targetId: adminAuditLog.targetId,
      ip: adminAuditLog.ip,
      userAgent: adminAuditLog.userAgent,
      beforeJsonb: adminAuditLog.beforeJsonb,
      afterJsonb: adminAuditLog.afterJsonb,
      occurredAt: adminAuditLog.occurredAt,
    })
    .from(adminAuditLog)
    .leftJoin(admins, eq(admins.id, adminAuditLog.adminId))
    .where(eq(adminAuditLog.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    adminId: r.adminId,
    adminEmail: r.adminEmail ?? null,
    action: r.action,
    targetKind: r.targetKind,
    targetId: r.targetId,
    ip: r.ip,
    userAgent: r.userAgent,
    beforeJsonb: (r.beforeJsonb ?? null) as Record<string, unknown> | null,
    afterJsonb: (r.afterJsonb ?? null) as Record<string, unknown> | null,
    occurredAt: r.occurredAt,
  };
}

// Suppress unused-locals warning for the drizzle helpers we don't always
// reach. Keeps the imports honest at the top of the file.
void lt;
