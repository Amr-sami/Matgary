// Push fan-out — the database half of push (doc 06 §8.3).
//
// `createNotification` (lib/repo/notifications.ts) is the single place every
// notification row is written — BOTH the preference-aware dispatcher (Path A)
// and the direct task / leave-decision calls (Path B) end up there — so one
// hook in it reaches every kind. This module is what that hook calls.
//
// Two rules the doc insists on and this file enforces:
//
//  1. Never push a row that has not committed. The hook fires from inside an
//     open transaction, so `notifyUserDevices` first waits until the row is
//     visible from a *different* connection (= committed). A rolled-back
//     transaction therefore pushes nothing, instead of sending the user to a
//     404.
//  2. Honour the user's channel toggles. The dispatcher only writes a row when
//     the recipient's `in_app` preference is on, and it tells the hook
//     whether this event should ALSO push (`push: false` for digest-mode
//     events such as `sale.created`, which follow the daily-digest logic —
//     §8.3). For the kinds that map 1:1 to an event type we re-check the
//     stored `in_app` AND `push` preference anyway (belt and braces — a row
//     written by a future producer that forgot the gate still must not buzz
//     a muted phone). Task and leave-decision kinds have no toggle today and
//     always push: they are the most time-sensitive ones for staff.
//
//  3. Remember every `ok` ticket. Expo only reports a dead device in the
//     RECEIPT, minutes later, so `handleOutcomes` queues the ticket id in
//     `push_receipts`; `./receipts.ts` drains that queue from the cron.

import { and, eq, inArray, isNull } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { notificationPreferences, notifications, pushReceipts, pushTokens } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { NotificationEventType } from "@/lib/notifications/event-types";
import type { NotificationKind } from "@/lib/repo/notifications";

import { sendPush, type PushData, type PushMessage, type PushOutcome, type SendPushOptions } from "./expo-push";

// ─── Route mapping ───────────────────────────────────────────────────────────
// `kind` → expo-router path. Mirrors what the web bell links to
// (components/notifications/NotificationBell.tsx uses `link` verbatim; these
// are the `link` values the producers write). The web `link` is passed through
// too so a producer that writes a deeper path (e.g. `/purchases/<id>`) wins.

const KIND_ROUTES: Partial<Record<NotificationKind, string>> = {
  low_stock: "/inventory",
  task_assigned: "/tasks",
  task_started: "/tasks",
  task_done: "/tasks",
  task_updated: "/tasks",
  leave_submitted: "/leave",
  leave_decided: "/leave",
};

const DEFAULT_ROUTE = "/notifications";

/** App route for a notification. A producer-supplied `link` (already an
 *  app-relative path) takes precedence; the kind table is the fallback. */
export function routeForNotification(kind: string, link: string | null | undefined): string {
  if (link && link.startsWith("/") && !link.startsWith("//")) return link;
  return KIND_ROUTES[kind as NotificationKind] ?? DEFAULT_ROUTE;
}

// ─── Preference gate ─────────────────────────────────────────────────────────
// Only the kinds that map to exactly one event type can be checked here; the
// dispatcher's own gate covers the rest (`info` is shared by three events).

const KIND_TO_EVENT: Partial<Record<NotificationKind, NotificationEventType>> = {
  low_stock: "inventory.low_stock",
  leave_submitted: "leave.requested",
};

// ─── Public API ──────────────────────────────────────────────────────────────

export interface NotifyUserDevicesInput {
  title: string;
  body?: string | null;
  data: PushData;
  /** When set, the send waits for this `notifications` row to be committed
   *  and skips entirely if it never is. Always pass it from the insert hook. */
  notificationId?: string | null;
}

export interface NotifyResult {
  /** Why nothing was sent, or "sent". */
  status: "sent" | "no_tokens" | "muted" | "uncommitted";
  outcomes: PushOutcome[];
  disabled: string[];
}

export interface NotifyOptions extends SendPushOptions {
  /** Test seam for the commit-visibility poll (ms between checks). */
  commitPollDelays?: readonly number[];
}

/**
 * Push `input` to every active device of `userId` in `tenantId`.
 * Never throws — push is best-effort and must not break the producer.
 */
export async function notifyUserDevices(
  tenantId: string,
  userId: string,
  input: NotifyUserDevicesInput,
  opts: NotifyOptions = {},
): Promise<NotifyResult> {
  try {
    if (input.notificationId) {
      const committed = await waitForCommit(
        tenantId,
        input.notificationId,
        opts.commitPollDelays ?? COMMIT_POLL_DELAYS,
      );
      if (!committed) {
        // Counted, not just logged: `push.dropped_uncommitted` is the metric
        // to alert on if producers ever routinely out-wait the schedule.
        droppedUncommitted += 1;
        logger.warn({
          event: "push.dropped_uncommitted",
          tenantId,
          userId,
          notificationId: input.notificationId,
          waitedMs: sum(opts.commitPollDelays ?? COMMIT_POLL_DELAYS),
          droppedTotal: droppedUncommitted,
        });
        return { status: "uncommitted", outcomes: [], disabled: [] };
      }
    }

    const eventType = KIND_TO_EVENT[input.data.type as NotificationKind];
    if (eventType && !(await pushEnabled(tenantId, userId, eventType))) {
      return { status: "muted", outcomes: [], disabled: [] };
    }

    const tokens = await activeTokens(tenantId, userId);
    if (tokens.length === 0) return { status: "no_tokens", outcomes: [], disabled: [] };

    const messages: PushMessage[] = tokens.map((to) => ({
      to,
      title: input.title,
      body: input.body ?? undefined,
      data: input.data,
    }));
    const outcomes = await sendPush(messages, opts);
    const disabled = await handleOutcomes(tenantId, userId, outcomes);
    return { status: "sent", outcomes, disabled };
  } catch (err) {
    logger.error({
      event: "push.notify_failed",
      tenantId,
      userId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { status: "no_tokens", outcomes: [], disabled: [] };
  }
}

/** Every live token for a user, oldest first. */
export async function activeTokens(tenantId: string, userId: string): Promise<string[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ token: pushTokens.expoToken })
      .from(pushTokens)
      .where(
        and(
          eq(pushTokens.tenantId, tenantId),
          eq(pushTokens.userId, userId),
          isNull(pushTokens.disabledAt),
        ),
      )
      .orderBy(pushTokens.createdAt);
    return rows.map((r) => r.token);
  });
}

/** Mark tokens dead. Idempotent: already-disabled rows keep their timestamp. */
export async function disableTokens(tenantId: string, tokens: readonly string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .update(pushTokens)
      .set({ disabledAt: new Date() })
      .where(and(inArray(pushTokens.expoToken, [...tokens]), isNull(pushTokens.disabledAt)))
      .returning({ id: pushTokens.id });
    return rows.length;
  });
}

/**
 * Apply Expo's verdicts: `DeviceNotRegistered` disables the token, every other
 * error is logged, and every `ok` ticket is queued for a receipt check
 * (`./receipts.ts`). Returns the tokens that were disabled.
 */
export async function handleOutcomes(
  tenantId: string,
  userId: string,
  outcomes: readonly PushOutcome[],
): Promise<string[]> {
  const dead: string[] = [];
  const pending: Array<{ tenantId: string; userId: string; expoToken: string; ticketId: string }> = [];
  for (const o of outcomes) {
    if (o.ticket.status === "ok") {
      pending.push({ tenantId, userId, expoToken: o.to, ticketId: o.ticket.id });
      continue;
    }
    if (o.deviceNotRegistered) {
      dead.push(o.to);
      continue;
    }
    logger.warn({
      event: "push.ticket_error",
      tenantId,
      userId,
      to: o.to.slice(0, 24) + "…",
      error: o.ticket.details?.error ?? null,
      message: o.ticket.message ?? null,
    });
  }
  if (dead.length > 0) {
    await disableTokens(tenantId, dead);
    logger.info({ event: "push.tokens_disabled", tenantId, userId, count: dead.length });
  }
  if (pending.length > 0) {
    await withTenant(tenantId, async (tx) => {
      await tx.insert(pushReceipts).values(pending);
    });
  }
  return dead;
}

// ─── Internals ───────────────────────────────────────────────────────────────

/** Backoff schedule (ms) for the commit-visibility poll. A normal commit
 *  lands inside the first two steps; the long tail (~30 s total) covers a
 *  bulk sale completion or a PO receive that holds its transaction open for
 *  many seconds — a push that arrives late still beats one that never
 *  arrives. Each step is one short transaction, so the tail does not add
 *  pool pressure, only wall time. The real fix (an after-commit hook on
 *  `withTenant`) lives in lib/db and is out of this module's reach. */
export const COMMIT_POLL_DELAYS: readonly number[] = [50, 150, 400, 1000, 2500, 5000, 10_000, 10_000];

/** Process-lifetime count of pushes dropped because the row never became
 *  visible — surfaced in every `push.dropped_uncommitted` log line. */
let droppedUncommitted = 0;

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

async function waitForCommit(
  tenantId: string,
  notificationId: string,
  delays: readonly number[],
): Promise<boolean> {
  for (const delay of delays) {
    await new Promise((r) => setTimeout(r, delay));
    // A fresh transaction on another pooled connection sees only committed
    // rows — that is the whole point of polling from outside the producer's tx.
    const visible = await withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.tenantId, tenantId), eq(notifications.id, notificationId)))
        .limit(1);
      return rows.length > 0;
    });
    if (visible) return true;
  }
  return false;
}

/** Stored `in_app && push` for one (user, event); no row = code default,
 *  which the dispatcher already applied when it decided to write the row. */
async function pushEnabled(
  tenantId: string,
  userId: string,
  eventType: NotificationEventType,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ inApp: notificationPreferences.inApp, push: notificationPreferences.push })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.tenantId, tenantId),
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.eventType, eventType),
        ),
      )
      .limit(1);
    return rows.length === 0 ? true : rows[0]!.inApp && rows[0]!.push;
  });
}
