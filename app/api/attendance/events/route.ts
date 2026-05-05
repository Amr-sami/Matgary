import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  listAttendanceEvents,
  recordAttendanceEvent,
  AttendanceStateError,
} from "@/lib/repo/attendance-events";

const TYPES = ["check_in", "check_out"] as const;
const SOURCES = ["manual", "geofence", "qr", "manager_attest"] as const;

const postSchema = z.object({
  employeeId: z.string().uuid(),
  type: z.enum(TYPES),
  source: z.enum(SOURCES),
  occurredAt: z.string().datetime().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  accuracyM: z.number().int().nonnegative().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export async function POST(req: NextRequest) {
  // Manager records on behalf of employees.
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  try {
    const event = await recordAttendanceEvent(r.ctx.tenantId, {
      employeeId: parsed.data.employeeId,
      type: parsed.data.type,
      source: parsed.data.source,
      occurredAt: parsed.data.occurredAt
        ? new Date(parsed.data.occurredAt)
        : undefined,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
      accuracyM: parsed.data.accuracyM ?? null,
      note: parsed.data.note ?? null,
      recordedByUserId: r.ctx.userId,
    });
    return NextResponse.json({ event }, { status: 201 });
  } catch (err) {
    if (err instanceof AttendanceStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

export async function GET(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const url = new URL(req.url);
  const employeeId = url.searchParams.get("employeeId") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const fromDate = fromStr ? new Date(fromStr) : startOfMonth(new Date());
  const toDate = toStr ? new Date(toStr) : endOfDay(new Date());
  const events = await listAttendanceEvents(r.ctx.tenantId, {
    employeeId,
    fromDate,
    toDate,
  });
  return NextResponse.json({ events });
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
