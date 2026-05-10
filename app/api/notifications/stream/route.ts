import type { NextRequest } from "next/server";
import { requireTenant } from "@/lib/api/auth-helpers";
import {
  listNotificationsForUser,
  unreadNotificationCount,
} from "@/lib/repo/notifications";
import { subscribeUserNotificationEvents } from "@/lib/notifications/events";

// Server-Sent Events endpoint that pushes notification updates to a single
// signed-in user. Replaces the per-tab 60 s polling that the bell used to do.
//
// Update flow:
//   1. Open the stream → send the current snapshot immediately so the UI is
//      populated without a separate round-trip.
//   2. Subscribe to the user's Redis pub/sub channel. Every notification
//      mutation (create / mark-read / mark-all) publishes a marker on that
//      channel; we re-fetch + emit on each marker.
//   3. Heartbeat every 25 s as an SSE comment to keep idle proxies from
//      collapsing the connection.
//   4. After STREAM_MAX_DURATION_MS the server closes the stream cleanly so
//      the client reconnects (avoids unbounded long-lived connections that
//      build up Redis subscribers if a user leaves a tab open for days).
//
// Fallbacks:
//   - Redis unavailable → subscribe call returns null. We fall back to the
//     same server-side polling but at a slower cadence than the old client
//     polling. The client never has to know.
//   - The SSE client (EventSource) auto-reconnects on disconnect, so the
//     forced close is invisible to the user.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const FALLBACK_POLL_MS = 15_000;
const STREAM_MAX_DURATION_MS = 5 * 60 * 1000; // 5 min, then client reconnects

export async function GET(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const { tenantId, userId } = r.ctx;

  const encoder = new TextEncoder();

  async function snapshot(): Promise<string> {
    const [items, unread] = await Promise.all([
      listNotificationsForUser(tenantId, userId, 30),
      unreadNotificationCount(tenantId, userId),
    ]);
    return JSON.stringify({
      data: items.map((n) => ({
        ...n,
        createdAt: n.createdAt.toISOString(),
      })),
      unread,
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastPayload = "";

      const send = (payload: string) => {
        if (closed) return;
        if (payload === lastPayload) return; // suppress duplicate emits
        lastPayload = payload;
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      };

      const sendComment = (text: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: ${text}\n\n`));
      };

      const refresh = async () => {
        try {
          send(await snapshot());
        } catch (err) {
          console.warn(
            "[notif/stream] snapshot failed:",
            err instanceof Error ? err.message : err,
          );
        }
      };

      // Initial snapshot — populates the UI immediately.
      await refresh();
      sendComment("connected");

      // Pub/sub subscription. Falls back to polling when Redis isn't
      // configured or the subscribe call fails.
      const sub = await subscribeUserNotificationEvents(userId, () => {
        void refresh();
      });

      const pollHandle =
        sub == null
          ? setInterval(() => void refresh(), FALLBACK_POLL_MS)
          : null;

      const heartbeat = setInterval(() => {
        sendComment("ping");
      }, HEARTBEAT_MS);

      const lifeguard = setTimeout(() => {
        // Gentle close so the client EventSource auto-reconnects.
        cleanup();
      }, STREAM_MAX_DURATION_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (pollHandle) clearInterval(pollHandle);
        clearTimeout(lifeguard);
        if (sub) void sub.unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Browser closed the tab / navigated away → tear down promptly.
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx default is to buffer proxied responses; this disables it for
      // this response so events flush in real time. Harmless on other
      // proxies.
      "X-Accel-Buffering": "no",
    },
  });
}
