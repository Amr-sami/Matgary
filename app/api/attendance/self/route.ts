import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenant } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import {
  AttendanceStateError,
  recordAttendanceEvent,
} from "@/lib/repo/attendance-events";
import { listStoreLocations } from "@/lib/repo/attendance";

const TYPES = ["check_in", "check_out"] as const;
const SOURCES = ["manual", "geofence"] as const;

const postSchema = z.object({
  type: z.enum(TYPES),
  source: z.enum(SOURCES),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  accuracyM: z.number().int().nonnegative().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

/**
 * Employee records their own check-in/out. The source dictates what we verify:
 *  - "manual" requires the attendance_self_manual permission.
 *  - "geofence" requires lat/lng inside one of the tenant's store_locations.
 */
export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  if (parsed.data.source === "manual") {
    if (!can(r.ctx, "attendance_self_manual")) {
      return NextResponse.json(
        { error: "ليس لديك صلاحية لتسجيل الحضور يدوياً" },
        { status: 403 },
      );
    }
  } else {
    // geofence — must be inside a configured location
    if (parsed.data.latitude == null || parsed.data.longitude == null) {
      return NextResponse.json(
        { error: "تعذر قراءة الموقع" },
        { status: 400 },
      );
    }
    const locations = await listStoreLocations(r.ctx.tenantId);
    if (locations.length === 0) {
      return NextResponse.json(
        { error: "لم يتم ضبط مواقع المتجر بعد" },
        { status: 409 },
      );
    }
    const inside = locations.some(
      (l) =>
        haversineMeters(
          parsed.data.latitude!,
          parsed.data.longitude!,
          l.latitude,
          l.longitude,
        ) <= l.geofenceRadiusM,
    );
    if (!inside) {
      return NextResponse.json(
        { error: "أنت خارج نطاق المتجر" },
        { status: 403 },
      );
    }
  }

  try {
    const event = await recordAttendanceEvent(r.ctx.tenantId, {
      employeeId: r.ctx.userId,
      type: parsed.data.type,
      source: parsed.data.source,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
      accuracyM: parsed.data.accuracyM ?? null,
      recordedByUserId: r.ctx.userId,
      note: parsed.data.note ?? null,
    });
    return NextResponse.json({ event }, { status: 201 });
  } catch (err) {
    if (err instanceof AttendanceStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

/** Distance between two lat/lng pairs in meters. */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
