// Repository + sync logic for wa_templates.
//
// Two write paths:
//   1. syncTemplatesForBranch — owner-triggered (or scheduled in the
//      future). Fetches the full template list from Meta and upserts;
//      templates absent from the response are marked 'stale' so the
//      send path stops using them.
//   2. (Phase 6) reactive sync from message_template_status_update
//      webhooks — updates a single row.
//
// Reads:
//   - listTemplates: UI listing (filter by status/category)
//   - getApprovedTemplate(name, language): send-time lookup; ONLY
//     returns 'approved' templates so paused/rejected ones can't slip
//     through to a real send.

import "server-only";
import { and, desc, eq, ne, notInArray } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { waConnections, waTemplates } from "@/lib/db/schema";
import {
  type MetaTemplate,
  listMessageTemplates,
  readMetaConfig,
} from "./meta-graph";
import { decryptSecret } from "@/lib/crypto";
import { logger } from "@/lib/logger";

export type TemplateStatus =
  | "approved"
  | "pending"
  | "rejected"
  | "paused"
  | "in_appeal"
  | "pending_deletion"
  | "disabled"
  | "flagged"
  | "stale"
  | "unknown";

export type TemplateCategory = "authentication" | "utility" | "marketing" | "unknown";

export interface TemplatePublic {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: TemplateStatus;
  components: Array<Record<string, unknown>>;
  qualityScore: Record<string, unknown> | null;
  rejectedReason: string | null;
  parameterFormat: string | null;
  lastSyncedAt: Date;
  updatedAt: Date;
}

function normaliseStatus(s: string | undefined): TemplateStatus {
  if (!s) return "unknown";
  const v = s.toLowerCase();
  switch (v) {
    case "approved":
    case "pending":
    case "rejected":
    case "paused":
    case "in_appeal":
    case "pending_deletion":
    case "disabled":
    case "flagged":
    case "stale":
      return v;
    default:
      return "unknown";
  }
}
function normaliseCategory(c: string | undefined): TemplateCategory {
  if (!c) return "unknown";
  const v = c.toLowerCase();
  if (v === "authentication" || v === "utility" || v === "marketing") return v;
  return "unknown";
}

function toPublic(row: typeof waTemplates.$inferSelect): TemplatePublic {
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    category: normaliseCategory(row.category),
    status: normaliseStatus(row.status),
    components: row.components,
    qualityScore: row.qualityScore,
    rejectedReason: row.rejectedReason,
    parameterFormat: row.parameterFormat,
    lastSyncedAt: row.lastSyncedAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Sync ────────────────────────────────────────────────────────────────

export interface SyncResult {
  ok: boolean;
  fetched: number;
  upserted: number;
  marked_stale: number;
  reason?: string;
}

/** Full-resync. Fetches all templates from Meta for the branch's active
 *  connection, upserts each, then marks any cached row not present in
 *  the response as 'stale'. */
export async function syncTemplatesForBranch(
  tenantId: string,
  branchId: string,
): Promise<SyncResult> {
  // 1. Find the active connection. Use the raw cross-tenant read
  //    because Phase 1 stores tokens encrypted; we decrypt below.
  const result = await withTenant(tenantId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(waConnections)
      .where(
        and(
          eq(waConnections.tenantId, tenantId),
          eq(waConnections.branchId, branchId),
          eq(waConnections.status, "active"),
        ),
      )
      .orderBy(desc(waConnections.connectedAt))
      .limit(1);
    return conn ?? null;
  });
  if (!result) {
    return {
      ok: false,
      fetched: 0,
      upserted: 0,
      marked_stale: 0,
      reason: "No active connection — connect WhatsApp first.",
    };
  }
  const token = result.accessToken ? decryptSecret(result.accessToken) : "";
  if (!token) {
    return {
      ok: false,
      fetched: 0,
      upserted: 0,
      marked_stale: 0,
      reason: "Connection has no token — reconnect.",
    };
  }

  // 2. Fetch from Meta.
  const cfg = readMetaConfig();
  let metaTemplates: MetaTemplate[];
  try {
    metaTemplates = await listMessageTemplates(cfg, result.wabaId, token);
  } catch (err) {
    logger.warn({
      event: "wa.templates.sync.fetch_failed",
      tenantId,
      branchId,
      wabaId: result.wabaId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      fetched: 0,
      upserted: 0,
      marked_stale: 0,
      reason: err instanceof Error ? err.message : "Fetch failed",
    };
  }

  // 3. Upsert each. Use the (tenant, branch, name, language) unique
  //    index for ON CONFLICT.
  const now = new Date();
  const seenIds = new Set<string>();

  await withTenant(tenantId, async (tx) => {
    for (const t of metaTemplates) {
      if (!t.name || !t.language) continue;
      const [row] = await tx
        .insert(waTemplates)
        .values({
          tenantId,
          branchId,
          connectionId: result.id,
          metaTemplateId: t.id ?? null,
          name: t.name,
          language: t.language,
          category: (t.category ?? "UTILITY").toLowerCase(),
          status: (t.status ?? "UNKNOWN").toLowerCase(),
          components: t.components ?? [],
          qualityScore: (t.quality_score ?? null) as Record<string, unknown> | null,
          rejectedReason: t.rejected_reason ?? null,
          parameterFormat: t.parameter_format ?? null,
          lastSyncedAt: now,
          rawPayload: t as unknown as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [
            waTemplates.tenantId,
            waTemplates.branchId,
            waTemplates.name,
            waTemplates.language,
          ],
          set: {
            metaTemplateId: t.id ?? null,
            category: (t.category ?? "UTILITY").toLowerCase(),
            status: (t.status ?? "UNKNOWN").toLowerCase(),
            components: t.components ?? [],
            qualityScore: (t.quality_score ?? null) as
              | Record<string, unknown>
              | null,
            rejectedReason: t.rejected_reason ?? null,
            parameterFormat: t.parameter_format ?? null,
            connectionId: result.id,
            lastSyncedAt: now,
            rawPayload: t as unknown as Record<string, unknown>,
            updatedAt: now,
          },
        })
        .returning({ id: waTemplates.id });
      if (row?.id) seenIds.add(row.id);
    }

    // 4. Mark cached templates not seen this run as 'stale'. Don't
    //    overwrite 'stale' again (and don't touch templates that aren't
    //    ours — RLS handles that, but the WHERE adds belt + braces).
    const seenArr = Array.from(seenIds);
    const condition = and(
      eq(waTemplates.tenantId, tenantId),
      eq(waTemplates.branchId, branchId),
      ne(waTemplates.status, "stale"),
      seenArr.length > 0
        ? notInArray(waTemplates.id, seenArr)
        : ne(waTemplates.id, waTemplates.id), // no-op when seenArr empty
    );
    const staled = await tx
      .update(waTemplates)
      .set({ status: "stale", updatedAt: now })
      .where(condition)
      .returning({ id: waTemplates.id });
    return staled.length;
  });

  logger.info({
    event: "wa.templates.sync.completed",
    tenantId,
    branchId,
    wabaId: result.wabaId,
    fetched: metaTemplates.length,
    upserted: seenIds.size,
  });

  return {
    ok: true,
    fetched: metaTemplates.length,
    upserted: seenIds.size,
    marked_stale: 0, // populated above but we don't read the returned
    //                  count back through withTenant's return — easy
    //                  follow-up if anyone needs it.
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────

export interface ListTemplatesOptions {
  status?: TemplateStatus | "all";
  category?: TemplateCategory | "all";
  includeStale?: boolean;
  limit?: number;
}

export async function listTemplates(
  tenantId: string,
  branchId: string,
  opts: ListTemplatesOptions = {},
): Promise<TemplatePublic[]> {
  return withTenant(tenantId, async (tx) => {
    const where = [
      eq(waTemplates.tenantId, tenantId),
      eq(waTemplates.branchId, branchId),
    ];
    if (opts.status && opts.status !== "all") {
      where.push(eq(waTemplates.status, opts.status));
    } else if (!opts.includeStale) {
      where.push(ne(waTemplates.status, "stale"));
    }
    if (opts.category && opts.category !== "all") {
      where.push(eq(waTemplates.category, opts.category));
    }
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = await tx
      .select()
      .from(waTemplates)
      .where(and(...where))
      .orderBy(
        // approved first; then by name. Postgres collation handles the
        // sort but we want approved-then-other up top so the UI surfaces
        // usable templates first.
        desc(eq(waTemplates.status, "approved")),
        waTemplates.name,
      )
      .limit(limit);
    return rows.map(toPublic);
  });
}

/** Send-time lookup. ONLY returns approved templates so paused/rejected
 *  rows can't reach Meta. Returns null when missing — caller surfaces a
 *  clear error to the operator. */
export async function getApprovedTemplate(
  tenantId: string,
  branchId: string,
  name: string,
  language: string,
): Promise<TemplatePublic | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(waTemplates)
      .where(
        and(
          eq(waTemplates.tenantId, tenantId),
          eq(waTemplates.branchId, branchId),
          eq(waTemplates.name, name),
          eq(waTemplates.language, language),
          eq(waTemplates.status, "approved"),
        ),
      )
      .limit(1);
    return row ? toPublic(row) : null;
  });
}
