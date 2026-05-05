import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  getAttendanceSettings,
  upsertAttendanceSettings,
} from "@/lib/repo/attendance";

export async function GET() {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const settings = await getAttendanceSettings(r.ctx.tenantId);
  return NextResponse.json({ settings });
}

const putSchema = z.object({
  workHoursPerDay: z.number().positive().max(24).optional(),
  weekendDays: z
    .array(z.number().int().min(1).max(7))
    .max(7)
    .optional(),
  overtimeMultiplier: z.number().min(1).max(5).optional(),
  graceMinutesLate: z.number().int().min(0).max(120).optional(),
});

export async function PUT(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  const settings = await upsertAttendanceSettings(r.ctx.tenantId, parsed.data);
  return NextResponse.json({ settings });
}
