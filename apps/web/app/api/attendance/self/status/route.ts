import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import { listAttendanceEvents } from "@/lib/repo/attendance-events";

/** Last attendance event the current employee has — used by the dashboard widget. */
export async function GET() {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  const today = new Date();
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const end = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    23,
    59,
    59,
    999,
  );
  const events = await listAttendanceEvents(r.ctx.tenantId, {
    employeeId: r.ctx.userId,
    fromDate: start,
    toDate: end,
  });
  const last = events[events.length - 1] ?? null;
  return NextResponse.json({ last });
}
