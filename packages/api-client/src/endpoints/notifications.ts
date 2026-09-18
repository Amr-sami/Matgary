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
  | "info";

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

/** Ask the server to push a test notification to this user's registered devices. */
export async function sendTestPush(c: ApiClient): Promise<TestPushResult> {
  return c.request<TestPushResult>("/api/v1/devices/push-token/test", {
    method: "POST",
    noBranch: true,
  });
}
