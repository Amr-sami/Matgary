import type { ApiClient } from "../http";

/**
 * Team + attendance endpoints. Thin wrappers over the web's own handlers
 * (apps/web/app/api/team/**, apps/web/app/api/attendance/**), which already
 * enforce tenant isolation and `manage_team`. Payload shapes mirror each
 * route's zod schema 1:1 — nothing the server rejects is offered here.
 *
 * Note the attendance routes are tenant-wide, not branch-scoped (doc 02 §2.8);
 * the X-Branch-Id header the client adds is simply ignored by them.
 */

// ---------------------------------------------------------------------------
// Team members

export type TeamRole = "owner" | "manager" | "staff" | "cashier" | string;

/** Full row from GET /api/team (apps/web/lib/repo/team.ts listTeamMembers). */
export interface TeamMemberDetail {
  userId: string;
  loginEmail: string;
  username: string;
  displayName: string;
  role: TeamRole;
  permissions: string[];
  mustChangePassword: boolean;
  joinedAt: string | null;
  phone: string | null;
  nationalId: string | null;
  address: string | null;
  profilePhotoPath: string | null;
  idPhotoPath: string | null;
  branchId: string | null;
}

export async function listTeam(c: ApiClient): Promise<TeamMemberDetail[]> {
  const res = await c.request<{ data: TeamMemberDetail[] }>("/api/team");
  return res.data ?? [];
}

/**
 * There is no GET /api/team/[userId] on the web — the detail view is the
 * list row. Resolve it the same way; the list is small (a store's staff).
 */
export async function getMember(
  c: ApiClient,
  userId: string,
): Promise<TeamMemberDetail | null> {
  const rows = await listTeam(c);
  return rows.find((m) => m.userId === userId) ?? null;
}

/** PATCH /api/team/[userId] body — every field optional. */
export interface UpdateMemberInput {
  displayName?: string;
  permissions?: string[];
  phone?: string | null;
  nationalId?: string | null;
  address?: string | null;
  branchId?: string;
}

export const updateMember = (
  c: ApiClient,
  userId: string,
  input: UpdateMemberInput,
) =>
  c.request<{ ok: true }>(`/api/team/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: input,
  });

/** DELETE /api/team/[userId] — removes the member from the tenant. */
export const removeMember = (c: ApiClient, userId: string) =>
  c.request<{ ok: true }>(`/api/team/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });

/** POST /api/team/[userId]/password — manager reset. 8..128 chars. 429 when rate-limited. */
export const resetPassword = (c: ApiClient, userId: string, newPassword: string) =>
  c.request<{ ok: true }>(`/api/team/${encodeURIComponent(userId)}/password`, {
    method: "POST",
    body: { newPassword },
  });

// ---------------------------------------------------------------------------
// Compensation (payroll)

export type PayType = "fixed" | "hourly" | "hybrid";

export interface CompensationRow {
  id: string;
  employeeId: string;
  payType: PayType;
  baseSalaryMonthly: number | null;
  hourlyRate: number | null;
  standardMonthlyHours: number | null;
  effectiveFrom: string;
  createdByUserId: string;
  createdAt: string;
}

/** GET /api/team/[userId]/compensation — newest first. */
export async function listCompensation(
  c: ApiClient,
  userId: string,
): Promise<CompensationRow[]> {
  const res = await c.request<{ history: CompensationRow[] }>(
    `/api/team/${encodeURIComponent(userId)}/compensation`,
  );
  return res.history ?? [];
}

export interface SetCompensationInput {
  payType: PayType;
  baseSalaryMonthly?: number | null;
  hourlyRate?: number | null;
  standardMonthlyHours?: number | null;
  /** ISO datetime. Defaults to now on the server. */
  effectiveFrom?: string;
}

/** POST /api/team/[userId]/compensation — 201 { row }. */
export const setCompensation = (
  c: ApiClient,
  userId: string,
  input: SetCompensationInput,
) =>
  c.request<{ row: CompensationRow }>(
    `/api/team/${encodeURIComponent(userId)}/compensation`,
    { method: "POST", body: input },
  );

// ---------------------------------------------------------------------------
// Attendance

export type AttendanceType = "check_in" | "check_out";
export type AttendanceSource = "manual" | "geofence" | "qr" | "manager_attest";

export interface AttendanceEvent {
  id: string;
  employeeId: string;
  type: AttendanceType;
  /** ISO. */
  occurredAt: string;
  source: AttendanceSource;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  recordedByUserId: string;
  note: string | null;
  requiresReview: boolean;
}

export type RosterStatus = "checked_in" | "checked_out" | "absent";

export interface RosterRow {
  userId: string;
  displayName: string;
  username: string;
  status: RosterStatus;
  lastEvent: AttendanceEvent | null;
}

/** GET /api/attendance/today — non-owner members with their latest event today. */
export async function attendanceToday(c: ApiClient): Promise<RosterRow[]> {
  const res = await c.request<{ roster: RosterRow[] }>("/api/attendance/today");
  return res.roster ?? [];
}

/**
 * GET /api/attendance/events?employeeId&from&to — `from`/`to` are ISO
 * datetimes; the server defaults to the current month when omitted.
 */
export async function listAttendanceEvents(
  c: ApiClient,
  args: { employeeId?: string; from?: string; to?: string } = {},
): Promise<AttendanceEvent[]> {
  const res = await c.request<{ events: AttendanceEvent[] }>(
    "/api/attendance/events",
    { query: { employeeId: args.employeeId, from: args.from, to: args.to } },
  );
  return res.events ?? [];
}

export interface RecordAttendanceInput {
  employeeId: string;
  type: AttendanceType;
  source: AttendanceSource;
  /** ISO datetime; defaults to now. */
  occurredAt?: string;
  note?: string | null;
}

/** POST /api/attendance/events — 201 { event }; 409 on an invalid in/out sequence. */
export const recordAttendanceEvent = (c: ApiClient, input: RecordAttendanceInput) =>
  c.request<{ event: AttendanceEvent }>("/api/attendance/events", {
    method: "POST",
    body: input,
  });

export interface UpdateAttendanceInput {
  type?: AttendanceType;
  occurredAt?: string;
  note?: string | null;
  requiresReview?: boolean;
}

/** PATCH /api/attendance/events/[id]. */
export const updateAttendanceEvent = (
  c: ApiClient,
  id: string,
  input: UpdateAttendanceInput,
) =>
  c.request<{ event: AttendanceEvent }>(
    `/api/attendance/events/${encodeURIComponent(id)}`,
    { method: "PATCH", body: input },
  );

/** DELETE /api/attendance/events/[id]. */
export const deleteAttendanceEvent = (c: ApiClient, id: string) =>
  c.request<{ ok: true }>(`/api/attendance/events/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export interface MonthlyShift {
  date: string;
  dayOfWeek: number;
  isWeekend: boolean;
  checkInAt: string;
  checkOutAt: string | null;
  hours: number;
  requiresReview: boolean;
  checkInSource: string;
  checkOutSource: string | null;
  note: string | null;
}

export interface MonthlyEmployee {
  userId: string;
  displayName: string;
  username: string;
  totals: {
    shifts: number;
    hoursTotal: number;
    regularHours: number;
    weekendHours: number;
    daysWorked: number;
    reviewCount: number;
    expectedHours: number;
  };
  shifts: MonthlyShift[];
}

export interface MonthlyAttendance {
  month: string;
  startsAt: string;
  endsAt: string;
  workingDaysInMonth: number;
  settings: { workHoursPerDay: number; weekendDays: number[] };
  employees: MonthlyEmployee[];
}

/** GET /api/attendance/monthly?month=YYYY-MM[&employeeId]. */
export const monthlyAttendance = (
  c: ApiClient,
  month: string,
  employeeId?: string,
) =>
  c.request<MonthlyAttendance>("/api/attendance/monthly", {
    query: { month, employeeId },
  });

// ---------------------------------------------------------------------------
// Leave (read-only summary for the member page; the Leave screen owns writes)

export type LeaveStatus = "pending" | "approved" | "rejected";

export interface LeaveRequestRow {
  id: string;
  userId: string;
  userName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: LeaveStatus;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

/** GET /api/leave-requests — managers see everyone; filter client-side per member. */
export async function listLeaveRequests(c: ApiClient): Promise<LeaveRequestRow[]> {
  const res = await c.request<{ data: LeaveRequestRow[] }>("/api/leave-requests");
  return res.data ?? [];
}
