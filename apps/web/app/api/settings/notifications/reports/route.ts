// Notification Center — report scheduler config.
//
// GET  → current tenant_report_settings (or defaults when no row exists).
// PATCH → owner / manage_settings only. Any subset of the fields. Writes an
//        audit trail entry before returning.

import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { tenantReportSettings } from "@/lib/db/schema";
import { requireTenant } from "@/lib/api/auth-helpers";
import { logActivity } from "@/lib/repo/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULTS = {
  dailyEnabled: true,
  dailyHour: 21,
  dailyMinute: 0,
  weeklyEnabled: true,
  weeklyDow: 0,
  weeklyHour: 9,
  weeklyMinute: 0,
  monthlyEnabled: true,
  monthlyDay: 1,
  monthlyHour: 9,
  monthlyMinute: 0,
  recipients: [] as string[],
} as const;

const patchSchema = z.object({
  dailyEnabled: z.boolean().optional(),
  dailyHour: z.number().int().min(0).max(23).optional(),
  dailyMinute: z.number().int().min(0).max(59).optional(),
  weeklyEnabled: z.boolean().optional(),
  weeklyDow: z.number().int().min(0).max(6).optional(),
  weeklyHour: z.number().int().min(0).max(23).optional(),
  weeklyMinute: z.number().int().min(0).max(59).optional(),
  monthlyEnabled: z.boolean().optional(),
  monthlyDay: z.number().int().min(1).max(28).optional(),
  monthlyHour: z.number().int().min(0).max(23).optional(),
  monthlyMinute: z.number().int().min(0).max(59).optional(),
  recipients: z.array(z.string().uuid()).max(50).optional(),
});

export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  const [row] = await db
    .select()
    .from(tenantReportSettings)
    .where(eq(tenantReportSettings.tenantId, r.ctx.tenantId))
    .limit(1);

  if (!row) {
    return NextResponse.json({
      tenantId: r.ctx.tenantId,
      ...DEFAULTS,
      isDefault: true,
    });
  }

  return NextResponse.json({
    tenantId: row.tenantId,
    dailyEnabled: row.dailyEnabled,
    dailyHour: row.dailyHour,
    dailyMinute: row.dailyMinute,
    weeklyEnabled: row.weeklyEnabled,
    weeklyDow: row.weeklyDow,
    weeklyHour: row.weeklyHour,
    weeklyMinute: row.weeklyMinute,
    monthlyEnabled: row.monthlyEnabled,
    monthlyDay: row.monthlyDay,
    monthlyHour: row.monthlyHour,
    monthlyMinute: row.monthlyMinute,
    recipients: row.recipients,
    updatedAt: row.updatedAt.toISOString(),
    isDefault: false,
  });
}

export async function PATCH(req: Request) {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  const canManage =
    r.ctx.role === "owner" || r.ctx.permissions.includes("view_settings");
  if (!canManage) {
    return NextResponse.json(
      { error: "FORBIDDEN", reason: "view_settings required" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_BODY", issue: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const [existing] = await db
    .select()
    .from(tenantReportSettings)
    .where(eq(tenantReportSettings.tenantId, r.ctx.tenantId))
    .limit(1);

  const base = existing ?? { tenantId: r.ctx.tenantId, ...DEFAULTS, updatedAt: new Date() };
  const next = {
    tenantId: r.ctx.tenantId,
    dailyEnabled: parsed.data.dailyEnabled ?? base.dailyEnabled,
    dailyHour: parsed.data.dailyHour ?? base.dailyHour,
    dailyMinute: parsed.data.dailyMinute ?? base.dailyMinute,
    weeklyEnabled: parsed.data.weeklyEnabled ?? base.weeklyEnabled,
    weeklyDow: parsed.data.weeklyDow ?? base.weeklyDow,
    weeklyHour: parsed.data.weeklyHour ?? base.weeklyHour,
    weeklyMinute: parsed.data.weeklyMinute ?? base.weeklyMinute,
    monthlyEnabled: parsed.data.monthlyEnabled ?? base.monthlyEnabled,
    monthlyDay: parsed.data.monthlyDay ?? base.monthlyDay,
    monthlyHour: parsed.data.monthlyHour ?? base.monthlyHour,
    monthlyMinute: parsed.data.monthlyMinute ?? base.monthlyMinute,
    recipients: parsed.data.recipients ?? base.recipients,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(tenantReportSettings)
      .set({
        dailyEnabled: next.dailyEnabled,
        dailyHour: next.dailyHour,
        dailyMinute: next.dailyMinute,
        weeklyEnabled: next.weeklyEnabled,
        weeklyDow: next.weeklyDow,
        weeklyHour: next.weeklyHour,
        weeklyMinute: next.weeklyMinute,
        monthlyEnabled: next.monthlyEnabled,
        monthlyDay: next.monthlyDay,
        monthlyHour: next.monthlyHour,
        monthlyMinute: next.monthlyMinute,
        recipients: next.recipients as string[],
        updatedAt: next.updatedAt,
      })
      .where(eq(tenantReportSettings.tenantId, r.ctx.tenantId));
  } else {
    await db.insert(tenantReportSettings).values({
      tenantId: r.ctx.tenantId,
      dailyEnabled: next.dailyEnabled,
      dailyHour: next.dailyHour,
      dailyMinute: next.dailyMinute,
      weeklyEnabled: next.weeklyEnabled,
      weeklyDow: next.weeklyDow,
      weeklyHour: next.weeklyHour,
      weeklyMinute: next.weeklyMinute,
      monthlyEnabled: next.monthlyEnabled,
      monthlyDay: next.monthlyDay,
      monthlyHour: next.monthlyHour,
      monthlyMinute: next.monthlyMinute,
      recipients: next.recipients as string[],
    });
  }

  await logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "report.schedule.changed",
    category: "settings",
    entityType: "tenant_report_settings",
    entityId: r.ctx.tenantId,
    metadata: {
      before: existing
        ? {
            dailyEnabled: existing.dailyEnabled,
            dailyHour: existing.dailyHour,
            weeklyEnabled: existing.weeklyEnabled,
            weeklyDow: existing.weeklyDow,
            monthlyEnabled: existing.monthlyEnabled,
            monthlyDay: existing.monthlyDay,
            recipients: existing.recipients,
          }
        : null,
      after: {
        dailyEnabled: next.dailyEnabled,
        dailyHour: next.dailyHour,
        weeklyEnabled: next.weeklyEnabled,
        weeklyDow: next.weeklyDow,
        monthlyEnabled: next.monthlyEnabled,
        monthlyDay: next.monthlyDay,
        recipients: next.recipients,
      },
    },
  });

  return NextResponse.json({ ok: true, settings: next });
}
