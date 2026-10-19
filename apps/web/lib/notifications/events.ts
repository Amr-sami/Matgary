import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

// Per-user notification event channel. The SSE stream subscribes to a user's
// channel; every notification mutation (insert / mark-read / mark-all-read)
// publishes a single empty marker. The SSE handler doesn't care about the
// message contents — it just re-fetches the user's list on each tick.
//
// Why "marker only" and not the full payload?
//   - Keeps the publish atomic and small (no race between row commit and
//     payload serialisation).
//   - The SSE handler does the read inside its own tenant-scoped tx, so RLS
//     stays the source of truth for who can see what.
//   - One refetch on a stale event is cheaper than a missed update.

export const NOTIFICATION_EVENT_CHANNEL = "notif:user";

function channelKey(userId: string): string {
  return `${NOTIFICATION_EVENT_CHANNEL}:${userId}`;
}

/**
 * Fire-and-forget publish. Errors are swallowed: the worst case is one tab
 * misses an update for ~30 s until the next heartbeat refetch. Don't ever
 * make a notification mutation depend on the publish succeeding.
 */
export async function publishUserNotificationEvent(
  userId: string,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.publish(channelKey(userId), "1");
  } catch (err) {
    logger.warn({
      event: "notif.events.publish_failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What an open dashboard tab receives for a sale alert (doc 16 §6). Rides
 *  the same per-user channel as the bell marker; the stream route tells the
 *  two apart by the leading `{`. `origin` is only ever a `web:<uuid>` tab
 *  origin (or null) — an Expo push token is never forwarded to a browser. */
export interface SaleAlertEvent {
  t: "sale_alert";
  /** Anchor sale line id, or `summary:<ts>` for a burst summary. */
  id: string;
  title: string;
  body: string | null;
  link: string;
  origin: string | null;
}

/** Fire-and-forget publish of a sale alert to one user's open tabs. */
export async function publishUserSaleAlert(
  userId: string,
  payload: Omit<SaleAlertEvent, "t">,
): Promise<void> {
  if (!redis) return;
  const origin =
    typeof payload.origin === "string" && payload.origin.startsWith("web:") ? payload.origin : null;
  const message: SaleAlertEvent = {
    t: "sale_alert",
    id: payload.id,
    title: payload.title,
    body: payload.body,
    link: payload.link,
    origin,
  };
  try {
    await redis.publish(channelKey(userId), JSON.stringify(message));
  } catch (err) {
    logger.warn({
      event: "notif.events.sale_alert_publish_failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The parsed sale alert when `message` is one, else null (a bell marker). */
export function parseSaleAlertMessage(message: string): SaleAlertEvent | null {
  if (!message.startsWith("{")) return null;
  try {
    const v = JSON.parse(message) as Partial<SaleAlertEvent>;
    if (v && v.t === "sale_alert" && typeof v.id === "string" && typeof v.title === "string") {
      return v as SaleAlertEvent;
    }
  } catch {
    // not JSON — treat as a marker
  }
  return null;
}

/** One SSE frame for a sale alert: `event: sale_alert` + its JSON. */
export function formatSaleAlertSse(alert: SaleAlertEvent): string {
  return `event: sale_alert\ndata: ${JSON.stringify(alert)}\n\n`;
}

export interface NotificationSubscription {
  /** Tear down the Redis subscriber. Idempotent. */
  unsubscribe: () => Promise<void>;
}

/**
 * Subscribe to a single user's channel. Allocates a dedicated Redis client
 * (ioredis blocks the connection while in subscribe mode) and pumps the
 * `onMessage` callback on each event.
 *
 * Returns null when Redis isn't configured — caller should fall back to
 * polling.
 */
export async function subscribeUserNotificationEvents(
  userId: string,
  onMessage: (message: string) => void,
): Promise<NotificationSubscription | null> {
  if (!redis) return null;
  const subscriber = redis.duplicate();
  let closed = false;
  subscriber.on("message", (_channel, message: string) => {
    if (!closed) onMessage(typeof message === "string" ? message : String(message));
  });
  subscriber.on("error", (err) => {
    // Don't tear down — ioredis will reconnect on its own. We only log once.
    if (!closed) {
      logger.warn({
        event: "notif.events.subscriber_error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });
  try {
    await subscriber.subscribe(channelKey(userId));
  } catch (err) {
    closed = true;
    void subscriber.quit().catch(() => {});
    logger.warn({
      event: "notif.events.subscribe_failed",
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return {
    unsubscribe: async () => {
      if (closed) return;
      closed = true;
      try {
        await subscriber.unsubscribe(channelKey(userId));
      } catch {
        // ignore — we're tearing down anyway
      }
      try {
        await subscriber.quit();
      } catch {
        // ignore
      }
    },
  };
}
