import { redis } from "@/lib/redis";

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
    console.warn(
      "[notif/events] publish failed:",
      err instanceof Error ? err.message : err,
    );
  }
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
  onMessage: () => void,
): Promise<NotificationSubscription | null> {
  if (!redis) return null;
  const subscriber = redis.duplicate();
  let closed = false;
  subscriber.on("message", (_channel, _message) => {
    if (!closed) onMessage();
  });
  subscriber.on("error", (err) => {
    // Don't tear down — ioredis will reconnect on its own. We only log once.
    if (!closed) {
      console.warn(
        "[notif/events] subscriber error:",
        err instanceof Error ? err.message : err,
      );
    }
  });
  try {
    await subscriber.subscribe(channelKey(userId));
  } catch (err) {
    closed = true;
    void subscriber.quit().catch(() => {});
    console.warn(
      "[notif/events] subscribe failed:",
      err instanceof Error ? err.message : err,
    );
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
