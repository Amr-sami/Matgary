// Admin write side for platform_broadcasts. Read side for tenant code is
// in lib/broadcasts.ts (does not go through the BYPASSRLS pool).

import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { platformBroadcasts } from "@/lib/db/schema";
import { getAdminDb } from "./db";
import { logAuditEvent } from "./audit";
import { bustBroadcastsCache } from "@/lib/broadcasts";

export type BroadcastSeverity = "info" | "warning" | "critical";
export type BroadcastAudience = "all" | "owners" | "staff";

export interface BroadcastRow {
  id: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string | null;
  bodyEn: string | null;
  severity: BroadcastSeverity;
  audience: BroadcastAudience;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
  createdByAdminId: string | null;
}

export class BroadcastError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ActionMeta {
  ip: string | null;
  userAgent: string | null;
}

export async function listAllBroadcasts(): Promise<BroadcastRow[]> {
  const db = getAdminDb();
  const rows = await db
    .select()
    .from(platformBroadcasts)
    .orderBy(desc(platformBroadcasts.startsAt));
  return rows.map(rowToBroadcast);
}

export interface CreateBroadcastInput {
  titleAr: string;
  titleEn: string;
  bodyAr?: string | null;
  bodyEn?: string | null;
  severity: BroadcastSeverity;
  audience: BroadcastAudience;
  startsAt: Date;
  endsAt: Date | null;
}

export async function createBroadcast(
  adminId: string,
  input: CreateBroadcastInput,
  meta: ActionMeta,
): Promise<{ id: string }> {
  validateInput(input);
  const db = getAdminDb();
  const [created] = await db
    .insert(platformBroadcasts)
    .values({
      titleAr: input.titleAr.trim(),
      titleEn: input.titleEn.trim(),
      bodyAr: input.bodyAr?.trim() || null,
      bodyEn: input.bodyEn?.trim() || null,
      severity: input.severity,
      audience: input.audience,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdByAdminId: adminId,
    })
    .returning({ id: platformBroadcasts.id });

  await logAuditEvent({
    adminId,
    action: "broadcast.create",
    targetKind: "broadcast",
    targetId: created.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: null,
    after: {
      titleEn: input.titleEn,
      severity: input.severity,
      audience: input.audience,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt?.toISOString() ?? null,
    },
  });
  await bustBroadcastsCache();
  return { id: created.id };
}

export interface PatchBroadcastInput extends Partial<CreateBroadcastInput> {}

export async function patchBroadcast(
  adminId: string,
  id: string,
  patch: PatchBroadcastInput,
  meta: ActionMeta,
): Promise<void> {
  const db = getAdminDb();
  const [existing] = await db
    .select()
    .from(platformBroadcasts)
    .where(eq(platformBroadcasts.id, id))
    .limit(1);
  if (!existing) throw new BroadcastError("NOT_FOUND", "Broadcast not found", 404);

  const merged: CreateBroadcastInput = {
    titleAr: patch.titleAr ?? existing.titleAr,
    titleEn: patch.titleEn ?? existing.titleEn,
    bodyAr: patch.bodyAr ?? existing.bodyAr,
    bodyEn: patch.bodyEn ?? existing.bodyEn,
    severity: (patch.severity ?? existing.severity) as BroadcastSeverity,
    audience: (patch.audience ?? existing.audience) as BroadcastAudience,
    startsAt: patch.startsAt ?? existing.startsAt,
    endsAt: patch.endsAt ?? existing.endsAt,
  };
  validateInput(merged);

  const set: Record<string, unknown> = {};
  if (patch.titleAr !== undefined) set.titleAr = patch.titleAr.trim();
  if (patch.titleEn !== undefined) set.titleEn = patch.titleEn.trim();
  if (patch.bodyAr !== undefined) set.bodyAr = patch.bodyAr?.trim() || null;
  if (patch.bodyEn !== undefined) set.bodyEn = patch.bodyEn?.trim() || null;
  if (patch.severity !== undefined) set.severity = patch.severity;
  if (patch.audience !== undefined) set.audience = patch.audience;
  if (patch.startsAt !== undefined) set.startsAt = patch.startsAt;
  if (patch.endsAt !== undefined) set.endsAt = patch.endsAt;
  if (Object.keys(set).length === 0) return;

  await db
    .update(platformBroadcasts)
    .set(set)
    .where(eq(platformBroadcasts.id, id));

  await logAuditEvent({
    adminId,
    action: "broadcast.patch",
    targetKind: "broadcast",
    targetId: id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: rowToBroadcastAudit(existing),
    after: { ...rowToBroadcastAudit(existing), ...set },
  });
  await bustBroadcastsCache();
}

export async function endBroadcastEarly(
  adminId: string,
  id: string,
  meta: ActionMeta,
): Promise<void> {
  const db = getAdminDb();
  const [existing] = await db
    .select()
    .from(platformBroadcasts)
    .where(eq(platformBroadcasts.id, id))
    .limit(1);
  if (!existing) throw new BroadcastError("NOT_FOUND", "Broadcast not found", 404);

  const now = new Date();
  await db
    .update(platformBroadcasts)
    .set({ endsAt: now })
    .where(eq(platformBroadcasts.id, id));

  await logAuditEvent({
    adminId,
    action: "broadcast.end_now",
    targetKind: "broadcast",
    targetId: id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    before: { endsAt: existing.endsAt?.toISOString() ?? null },
    after: { endsAt: now.toISOString() },
  });
  await bustBroadcastsCache();
}

// ─── helpers ─────────────────────────────────────────────────────────────

function validateInput(input: CreateBroadcastInput) {
  if (!input.titleAr.trim() || input.titleAr.length > 120) {
    throw new BroadcastError("INVALID_TITLE_AR", "titleAr must be 1-120 chars", 400);
  }
  if (!input.titleEn.trim() || input.titleEn.length > 120) {
    throw new BroadcastError("INVALID_TITLE_EN", "titleEn must be 1-120 chars", 400);
  }
  if (input.bodyAr && input.bodyAr.length > 1000) {
    throw new BroadcastError("BODY_TOO_LONG", "bodyAr ≤ 1000", 400);
  }
  if (input.bodyEn && input.bodyEn.length > 1000) {
    throw new BroadcastError("BODY_TOO_LONG", "bodyEn ≤ 1000", 400);
  }
  if (
    input.severity !== "info" &&
    input.severity !== "warning" &&
    input.severity !== "critical"
  ) {
    throw new BroadcastError("INVALID_SEVERITY", "severity invalid", 400);
  }
  if (
    input.audience !== "all" &&
    input.audience !== "owners" &&
    input.audience !== "staff"
  ) {
    throw new BroadcastError("INVALID_AUDIENCE", "audience invalid", 400);
  }
  if (input.endsAt && input.endsAt <= input.startsAt) {
    throw new BroadcastError("INVALID_WINDOW", "endsAt must be after startsAt", 400);
  }
}

function rowToBroadcast(r: typeof platformBroadcasts.$inferSelect): BroadcastRow {
  return {
    id: r.id,
    titleAr: r.titleAr,
    titleEn: r.titleEn,
    bodyAr: r.bodyAr,
    bodyEn: r.bodyEn,
    severity: r.severity as BroadcastSeverity,
    audience: r.audience as BroadcastAudience,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    createdAt: r.createdAt,
    createdByAdminId: r.createdByAdminId,
  };
}

function rowToBroadcastAudit(r: typeof platformBroadcasts.$inferSelect): Record<string, unknown> {
  return {
    titleAr: r.titleAr,
    titleEn: r.titleEn,
    bodyAr: r.bodyAr,
    bodyEn: r.bodyEn,
    severity: r.severity,
    audience: r.audience,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt?.toISOString() ?? null,
  };
}

// Suppress unused-locals warning for the drizzle helpers re-exported for
// future read filters.
void and;
void or;
void gt;
void lt;
void isNull;
void sql;
