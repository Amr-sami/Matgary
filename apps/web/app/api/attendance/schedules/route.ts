// Employee attendance schedule — CRUD for N2 Late Arrivals.
//
// Owner / manage_team gated. Every write audit-logged. Tenant-scoped.
// Schedule lives in its own domain (employee_schedules), NOT in
// employee_compensation (per spec §10/§11).
//
// GET  → list all schedules in tenant (with user name for the UI table)
// POST → upsert one employee's schedule (idempotent via UNIQUE (tenant, user))

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  employeeSchedules,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import { requireTenant } from "@/lib/api/auth-helpers";
import { insertActivityRow } from "@/lib/repo/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORK_DAYS_MIN = 0;
const WORK_DAYS_MAX = 127; // 7-bit bitmask (Sun..Sat)

const upsertSchema = z.object({
  userId: z.string().uuid(),
  shiftStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "shiftStart must be HH:MM or HH:MM:SS"),
  shiftEnd: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "shiftEnd must be HH:MM or HH:MM:SS"),
  workDays: z.number().int().min(WORK_DAYS_MIN).max(WORK_DAYS_MAX),
  graceMinutes: z.number().int().min(-1).max(240),
  enabled: z.boolean().optional().default(true),
  timezoneOverride: z.string().max(60).nullable().optional(),
});

function canManage(role: string | null, perms: readonly string[]): boolean {
  return role === "owner" || perms.includes("manage_team");
}

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (!canManage(r.ctx.role, r.ctx.permissions)) {
    return NextResponse.json(
      { error: "FORBIDDEN", reason: "manage_team required" },
      { status: 403 },
    );
  }

  const rows = await withTenant(r.ctx.tenantId, (tx) =>
    tx
      .select({
        id: employeeSchedules.id,
        userId: employeeSchedules.userId,
        shiftStart: employeeSchedules.shiftStart,
        shiftEnd: employeeSchedules.shiftEnd,
        workDays: employeeSchedules.workDays,
        graceMinutes: employeeSchedules.graceMinutes,
        enabled: employeeSchedules.enabled,
        timezoneOverride: employeeSchedules.timezoneOverride,
        updatedAt: employeeSchedules.updatedAt,
        userName: users.name,
        userDisplayName: tenantMembers.displayName,
      })
      .from(employeeSchedules)
      .innerJoin(users, eq(users.id, employeeSchedules.userId))
      .innerJoin(
        tenantMembers,
        and(
          eq(tenantMembers.tenantId, employeeSchedules.tenantId),
          eq(tenantMembers.userId, employeeSchedules.userId),
        ),
      )
      .where(eq(employeeSchedules.tenantId, r.ctx.tenantId))
      .orderBy(sql`${users.name} asc`),
  );

  return NextResponse.json({
    tenantId: r.ctx.tenantId,
    schedules: rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      userName: row.userDisplayName ?? row.userName ?? null,
      shiftStart: row.shiftStart,
      shiftEnd: row.shiftEnd,
      workDays: row.workDays,
      graceMinutes: row.graceMinutes,
      enabled: row.enabled,
      timezoneOverride: row.timezoneOverride,
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (!canManage(r.ctx.role, r.ctx.permissions)) {
    return NextResponse.json(
      { error: "FORBIDDEN", reason: "manage_team required" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_BODY", issue: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  // Verify the target user is a tenant member. No one gets a schedule for a
  // user outside their tenant.
  const [member] = await withTenant(r.ctx.tenantId, (tx) =>
    tx
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, r.ctx.tenantId),
          eq(tenantMembers.userId, parsed.data.userId),
        ),
      )
      .limit(1),
  );
  if (!member) {
    return NextResponse.json(
      { error: "USER_NOT_IN_TENANT" },
      { status: 404 },
    );
  }

  // Normalise HH:MM → HH:MM:SS for Postgres `time` column consistency.
  const normTime = (v: string) => (v.length === 5 ? `${v}:00` : v);
  const shiftStart = normTime(parsed.data.shiftStart);
  const shiftEnd = normTime(parsed.data.shiftEnd);
  const enabled = parsed.data.enabled ?? true;
  const timezoneOverride = parsed.data.timezoneOverride ?? null;

  const [existing] = await withTenant(r.ctx.tenantId, (tx) =>
    tx
      .select()
      .from(employeeSchedules)
      .where(
        and(
          eq(employeeSchedules.tenantId, r.ctx.tenantId),
          eq(employeeSchedules.userId, parsed.data.userId),
        ),
      )
      .limit(1),
  );

  if (existing) {
    await withTenant(r.ctx.tenantId, (tx) =>
      tx
        .update(employeeSchedules)
        .set({
          shiftStart,
          shiftEnd,
          workDays: parsed.data.workDays,
          graceMinutes: parsed.data.graceMinutes,
          enabled,
          timezoneOverride,
          updatedAt: new Date(),
        })
        .where(eq(employeeSchedules.id, existing.id)),
    );
  } else {
    await withTenant(r.ctx.tenantId, (tx) =>
      tx.insert(employeeSchedules).values({
        tenantId: r.ctx.tenantId,
        userId: parsed.data.userId,
        shiftStart,
        shiftEnd,
        workDays: parsed.data.workDays,
        graceMinutes: parsed.data.graceMinutes,
        enabled,
        timezoneOverride,
      }),
    );
  }

  await insertActivityRow({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "attendance.schedule.changed",
    category: "attendance",
    entityType: "employee_schedule",
    entityId: parsed.data.userId,
    metadata: {
      before: existing
        ? {
            shiftStart: existing.shiftStart,
            shiftEnd: existing.shiftEnd,
            workDays: existing.workDays,
            graceMinutes: existing.graceMinutes,
            enabled: existing.enabled,
          }
        : null,
      after: {
        shiftStart,
        shiftEnd,
        workDays: parsed.data.workDays,
        graceMinutes: parsed.data.graceMinutes,
        enabled,
      },
    },
  });

  return NextResponse.json({ ok: true });
}
