import type { ApiClient } from "../http";

/**
 * Notification centre + push registration.
 *
 * The centre reads the SAME routes the (never-mounted) web bell was written
 * against — apps/web/app/api/notifications/** — so the mobile app is the first
 * real consumer of rows the fanout pipeline has been writing for months
 * (doc 02 §2.12). Push registration talks to /api/v1/devices/push-token,
 * built in parallel with this client; the shapes below are the agreed
 * contract, not a guess from the server code.
 */

export type NotificationKind =
  | "low_stock"
  | "task_assigned"
  | "task_started"
  | "task_done"
  | "task_updated"
  | "leave_submitted"
  | "leave_decided"
  | "info"
  // Digital collections (doc 15 spec 13 §4.6) — one kind per collection event.
  | "collection_pending"
  | "collection_stale"
  | "collection_unmatched"
  | "collection_source_silent"
  | "collection_limit"
  // Scheduled roll-ups (weekly + monthly). Shares one kind — the `link`
  // carries the specific route (/reports/weekly?period=... etc.).
  | "report";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  /** Web path the producer attached, e.g. "/sales", "/purchases/<id>". */
  link: string | null;
  isRead: boolean;
  /** ISO 8601 — the wire form; never a Date, so it survives the query cache. */
  createdAt: string;
}

export interface NotificationPage {
  data: NotificationItem[];
  /** Unread count for the whole inbox, not just this page. */
  unread: number;
  /**
   * Opaque cursor for the next page. The web route returns the newest 30 rows
   * and no cursor today; the client treats a missing/null cursor as "no more
   * pages", so this stays correct when the server grows paging.
   */
  nextCursor?: string | null;
}

export interface ListOptions {
  cursor?: string | null;
  limit?: number;
}

export async function list(
  c: ApiClient,
  opts: ListOptions = {},
): Promise<NotificationPage> {
  return c.request<NotificationPage>("/api/notifications", {
    query: { cursor: opts.cursor ?? undefined, limit: opts.limit },
  });
}

/**
 * Unread count for the bell. There is no dedicated count route and the list
 * route ignores every query param (it always returns the newest 30 rows plus
 * `unread`), so this is that call projected — the SAME transfer as `list()`.
 * The mobile bell therefore reads `unread` off the shared list query rather
 * than calling this; it stays for a consumer with no list in scope.
 */
export async function summary(c: ApiClient): Promise<{ unread: number }> {
  const page = await c.request<NotificationPage>("/api/notifications");
  return { unread: page.unread };
}

export async function markRead(c: ApiClient, id: string): Promise<void> {
  await c.request<{ ok: true }>(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: "POST",
  });
}

export async function markAllRead(c: ApiClient): Promise<void> {
  await c.request<{ ok: true }>("/api/notifications/read-all", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Push devices — POST /api/v1/devices/push-token, DELETE same path.
// ---------------------------------------------------------------------------

export interface RegisterPushTokenInput {
  /** Expo push token, "ExponentPushToken[…]". */
  token: string;
  platform: "ios" | "android";
  deviceName?: string;
}

/** Data block the server puts on every push; the client routes on `route`. */
export interface PushPayloadData {
  type: string;
  route: string;
  /** Row id when the push is about one entity; the test push sends `null`. */
  id?: string | null;
}

export async function registerPushToken(
  c: ApiClient,
  input: RegisterPushTokenInput,
): Promise<void> {
  await c.request<{ ok: true }>("/api/v1/devices/push-token", {
    method: "POST",
    body: input,
    noBranch: true,
  });
}

/**
 * Forget this device's token. Called from `auth.logout` BEFORE the session is
 * revoked, because once the bearer is gone the server cannot tell whose token
 * to drop. Best-effort: the caller must not block sign-out on it.
 */
export async function unregisterPushToken(
  c: ApiClient,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  await c.request<{ ok: true }>("/api/v1/devices/push-token", {
    method: "DELETE",
    body: { token },
    noBranch: true,
    signal,
  });
}

/** One Expo ticket per device, as echoed by the test route. */
export interface PushTicket {
  /** The Expo push token the ticket is for. */
  to: string;
  status: "ok" | "error";
  /** Expo's error code ("DeviceNotRegistered", …) when `status` is "error". */
  error: string | null;
}

/**
 * apps/web/app/api/v1/devices/push-token/test/route.ts — HTTP 200 does NOT
 * mean delivered: the route answers 200 with `sent: 0` when every ticket
 * failed, and `disabled` counts tokens it pruned as a side effect (a
 * DeviceNotRegistered token is gone from the server the moment this returns).
 */
export interface TestPushResult {
  ok: true;
  status: string;
  sent: number;
  failed: number;
  disabled: number;
  tickets: PushTicket[];
}

/**
 * Ask the server to push a test notification to this user's registered devices.
 * `kind: "sale"` sends a sample sale alert instead (channel `sales`, sound
 * `cha_ching.wav` — mobile-dev-docs/16-sale-alerts.md §8.11).
 */
export async function sendTestPush(
  c: ApiClient,
  opts?: { kind?: "sale" },
): Promise<TestPushResult> {
  return c.request<TestPushResult>("/api/v1/devices/push-token/test", {
    method: "POST",
    body: opts?.kind ? { kind: opts.kind } : {},
    noBranch: true,
  });
}

// ---------------------------------------------------------------------------
// Per-event preferences — GET / PUT /api/notifications/preferences
// (apps/web/app/api/notifications/preferences/route.ts, doc 06 §8.3).
// ---------------------------------------------------------------------------

export type NotificationEventType =
  | "sale.created"
  // Sale alerts (doc 16): the "cha-ching" push on every shop device. Only
  // `push` matters — the server forces inApp/email off and digestMode instant.
  | "sale.alert"
  | "purchase.received"
  | "inventory.low_stock"
  | "payment.deferred_settled"
  | "leave.requested"
  // Listed by the preferences GET only to members who can receive them
  // (doc 15 spec 13 D13-8): owners when collections are admitted, staff
  // holding the event's permission.
  | "collection.pending"
  | "collection.stale"
  | "collection.unmatched_credit"
  | "collection.source_silent"
  | "collection.limit_warning"
  // Phase B — scheduled roll-ups + instant business events (mirrors
  // apps/web/lib/notifications/event-types.ts NOTIFICATION_EVENT_TYPES).
  | "report.weekly"
  | "report.monthly"
  | "expense.recorded"
  | "product.added"
  | "inventory.adjusted"
  | "return.recorded"
  | "attendance.check_in"
  // Notification Center extension — mirrors apps/web/lib/notifications/event-types.ts
  | "purchase.created"
  | "purchase.returned"
  | "supplier.payment.recorded"
  | "customer.created"
  | "expense.voided"
  | "leave.approved"
  | "leave.rejected"
  | "payroll.calculated"
  | "payroll.finalized"
  | "payroll.voided"
  | "report.daily"
  | "attendance.late";

export type DigestMode = "instant" | "digest";

export interface EventPreference {
  eventType: NotificationEventType;
  /** Show it in the bell / notification centre. */
  inApp: boolean;
  /**
   * Buzz the phone for it. The server only sends a push when `inApp` is on
   * too, and never for digest-mode events (dispatch.ts) — the switch is the
   * user's "show it, don't buzz me" for the rest.
   */
  push: boolean;
  email: boolean;
  /** Email delivery: per event, or buffered into the daily digest. */
  digestMode: DigestMode;
  /** True when nothing is stored — every channel is the role default. */
  isDefault: boolean;
}

export interface NotificationPreferences {
  role: "owner" | "staff";
  preferences: EventPreference[];
}

export async function getPreferences(c: ApiClient): Promise<NotificationPreferences> {
  return c.request<NotificationPreferences>("/api/notifications/preferences", {
    noBranch: true,
  });
}

/** One event's full preference; the server deletes the row when it equals the role default. */
export type SetEventPreferenceInput = Omit<EventPreference, "isDefault">;

export async function setPreference(
  c: ApiClient,
  input: SetEventPreferenceInput,
): Promise<{ ok: true; isDefault: boolean }> {
  return c.request<{ ok: true; isDefault: boolean }>("/api/notifications/preferences", {
    method: "PUT",
    body: input,
    noBranch: true,
  });
}

// ---------------------------------------------------------------------------
// Notification Center — report scheduling (migration 0069).
// GET + PATCH /api/settings/notifications/reports.
// ---------------------------------------------------------------------------

export interface ReportSettings {
  tenantId: string;
  dailyEnabled: boolean;
  dailyHour: number;
  dailyMinute: number;
  weeklyEnabled: boolean;
  weeklyDow: number; // 0=Sun … 6=Sat
  weeklyHour: number;
  weeklyMinute: number;
  monthlyEnabled: boolean;
  monthlyDay: number; // 1..28
  monthlyHour: number;
  monthlyMinute: number;
  recipients: string[];
  isDefault?: boolean;
  updatedAt?: string;
}

export async function getReportSettings(c: ApiClient): Promise<ReportSettings> {
  return c.request<ReportSettings>("/api/settings/notifications/reports", {
    noBranch: true,
  });
}

export async function updateReportSettings(
  c: ApiClient,
  patch: Partial<Omit<ReportSettings, "tenantId" | "isDefault" | "updatedAt">>,
): Promise<{ ok: true; settings: ReportSettings }> {
  return c.request<{ ok: true; settings: ReportSettings }>(
    "/api/settings/notifications/reports",
    { method: "PATCH", body: patch, noBranch: true },
  );
}

// ---------------------------------------------------------------------------
// Attendance schedules (migration 0069 N2).
// GET + POST /api/attendance/schedules, DELETE /api/attendance/schedules/:userId.
// ---------------------------------------------------------------------------

export interface EmployeeSchedule {
  id: string;
  userId: string;
  userName: string | null;
  /** 'HH:MM:SS' (Postgres `time` column). */
  shiftStart: string;
  shiftEnd: string;
  /** 7-bit bitmask: bit 0 = Sun … bit 6 = Sat. Egypt default 125 (Fri off). */
  workDays: number;
  /** -1 = inherit tenant default (attendance_settings.grace_minutes_late). */
  graceMinutes: number;
  enabled: boolean;
  timezoneOverride: string | null;
  updatedAt: string;
}

export interface SchedulesResponse {
  tenantId: string;
  schedules: EmployeeSchedule[];
}

export async function listSchedules(c: ApiClient): Promise<SchedulesResponse> {
  return c.request<SchedulesResponse>("/api/attendance/schedules", {
    noBranch: true,
  });
}

export interface UpsertScheduleInput {
  userId: string;
  shiftStart: string; // HH:MM or HH:MM:SS
  shiftEnd: string;
  workDays: number;
  graceMinutes: number;
  enabled?: boolean;
  timezoneOverride?: string | null;
}

export async function upsertSchedule(
  c: ApiClient,
  input: UpsertScheduleInput,
): Promise<{ ok: true }> {
  return c.request<{ ok: true }>("/api/attendance/schedules", {
    method: "POST",
    body: input,
    noBranch: true,
  });
}

export async function deleteSchedule(
  c: ApiClient,
  userId: string,
): Promise<{ ok: true }> {
  return c.request<{ ok: true }>(`/api/attendance/schedules/${userId}`, {
    method: "DELETE",
    noBranch: true,
  });
}
