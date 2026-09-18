import type { ApiClient } from "../http";

/**
 * Attendance — the employee's own check-in/out plus the two manager-gated
 * readers the check-in screen uses to explain the geofence.
 *
 * Every route here is an existing web handler (apps/web/app/api/attendance/**)
 * that already enforces tenant scope and permissions; nothing is reimplemented.
 * Shapes mirror apps/web/lib/repo/attendance-events.ts and attendance.ts, with
 * Dates arriving as ISO strings over JSON.
 */

export type AttendanceType = "check_in" | "check_out";
export type AttendanceSource = "manual" | "geofence" | "qr" | "manager_attest";

/** AttendanceEventDto, serialised. */
export interface AttendanceEvent {
  id: string;
  employeeId: string;
  type: AttendanceType;
  /** ISO timestamp. */
  occurredAt: string;
  source: AttendanceSource;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  recordedByUserId: string;
  note: string | null;
  requiresReview: boolean;
}

/** StoreLocationDto — one geofence centre. Reading the list needs `manage_team`. */
export interface StoreLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
}

/**
 * Body of POST /api/attendance/self. `source: "geofence"` needs lat/lng and is
 * checked server-side against every store location (403 "أنت خارج نطاق المتجر"
 * when outside, 409 when none are configured). `source: "manual"` needs the
 * `attendance_self_manual` permission and ignores coordinates.
 * `accuracyM` must be a non-negative INTEGER (zod `.int()`).
 */
export interface SelfCheckBody {
  type: AttendanceType;
  source: "manual" | "geofence";
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  note?: string | null;
}

/** GET /api/attendance/self/status — the caller's last event TODAY (server-local day), or null. */
export async function selfStatus(c: ApiClient): Promise<AttendanceEvent | null> {
  const res = await c.request<{ last: AttendanceEvent | null }>(
    "/api/attendance/self/status",
  );
  return res.last ?? null;
}

/** POST /api/attendance/self — records the caller's own check-in/out. 201 → the event. */
export async function selfCheck(
  c: ApiClient,
  body: SelfCheckBody,
): Promise<AttendanceEvent> {
  const res = await c.request<{ event: AttendanceEvent }>("/api/attendance/self", {
    method: "POST",
    body,
  });
  return res.event;
}

/** GET /api/attendance/locations — every geofence centre in the tenant. Requires `manage_team`. */
export async function listLocations(c: ApiClient): Promise<StoreLocation[]> {
  const res = await c.request<{ locations: StoreLocation[] }>(
    "/api/attendance/locations",
  );
  return res.locations ?? [];
}

export interface ListEventsParams {
  employeeId?: string;
  /** ISO timestamps; the server defaults to start-of-month … end-of-today. */
  from?: string;
  to?: string;
}

/**
 * GET /api/attendance/events — raw events, oldest first. Requires `manage_team`
 * (there is no self-history route yet; see doc 02 §2.8), so the screen only
 * calls this when the session holds that permission.
 */
export async function listEvents(
  c: ApiClient,
  params: ListEventsParams = {},
): Promise<AttendanceEvent[]> {
  const res = await c.request<{ events: AttendanceEvent[] }>(
    "/api/attendance/events",
    { query: { employeeId: params.employeeId, from: params.from, to: params.to } },
  );
  return res.events ?? [];
}
