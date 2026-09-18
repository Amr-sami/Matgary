// Expo Push Service client — the transport half of push (doc 06 §8.2/§8.4).
//
// One HTTP endpoint for both platforms, one token format, and tickets that
// tell us when a token is dead so we can prune it. This module knows nothing
// about the database: it turns messages into HTTP calls and HTTP responses
// into per-message outcomes. `lib/push/notify.ts` decides what to do with
// them. `fetch` is injectable so tests never touch the network.

import { logger } from "@/lib/logger";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

/** Expo accepts at most 100 messages per send request… */
export const EXPO_PUSH_CHUNK = 100;
/** …and at most 1000 ticket ids per receipts request. */
export const EXPO_RECEIPT_CHUNK = 1000;

/** Hard ceiling on one Expo round-trip. The fan-out is fire-and-forget from
 *  inside a producer's request, so a hung exp.host must degrade into the
 *  `push.expo_network_failed` path instead of a promise that never settles
 *  (undici's own headers timeout is five minutes). */
export const EXPO_TIMEOUT_MS = 10_000;

/** `ExponentPushToken[xxx]` (bare workflow) or `ExpoPushToken[xxx]` (EAS). */
export const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[.+\]$/;

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && EXPO_TOKEN_RE.test(value);
}

/** What lands on the device. `data` is the deep-link contract the mobile app
 *  routes off — `{ type, route, id }` — plus anything else the producer wants
 *  to carry. Keep it under Expo's 4 KiB payload limit. */
export interface PushData {
  type: string;
  route: string;
  id: string | null;
  [key: string]: unknown;
}

export interface PushMessage {
  to: string;
  title: string;
  body?: string;
  data?: PushData;
}

/** The wire shape actually POSTed. Fields beyond `PushMessage` are fixed
 *  policy: every TheStoro push sounds, goes to the `default` Android
 *  channel, and is high-priority (a late "task assigned" is useless). */
export interface ExpoPushRequest {
  to: string;
  title: string;
  body?: string;
  data?: PushData;
  sound: "default";
  channelId: "default";
  priority: "high";
}

export type ExpoTicket =
  | { status: "ok"; id: string }
  | {
      status: "error";
      message?: string;
      details?: { error?: string; [key: string]: unknown };
    };

/** What `getReceipts` says about one ticket, once the receipt exists. Same
 *  shape as a ticket minus the `id`; `DeviceNotRegistered` here is the signal
 *  a ticket-level check can never give us for a real uninstall. */
export type ExpoReceipt =
  | { status: "ok" }
  | {
      status: "error";
      message?: string;
      details?: { error?: string; [key: string]: unknown };
    };

export interface PushOutcome {
  to: string;
  ticket: ExpoTicket;
  /** True only for `DeviceNotRegistered` — the one error that means "this
   *  token is dead, stop sending". Everything else is transient or ours. */
  deviceNotRegistered: boolean;
}

export interface SendPushOptions {
  /** Test seam. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Optional Expo access token (enhanced security mode on the Expo side). */
  accessToken?: string | null;
  /** Per-request timeout. Defaults to EXPO_TIMEOUT_MS; tests shorten it. */
  timeoutMs?: number;
}

export function toExpoRequest(m: PushMessage): ExpoPushRequest {
  const req: ExpoPushRequest = {
    to: m.to,
    title: m.title,
    sound: "default",
    channelId: "default",
    priority: "high",
  };
  if (m.body) req.body = m.body;
  if (m.data) req.data = m.data;
  return req;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * POST `messages` to Expo in chunks of 100 and return one outcome per message,
 * in input order. Never throws: a chunk whose HTTP call fails yields an error
 * ticket per message (so the caller can log it) and the remaining chunks are
 * still attempted.
 */
export async function sendPush(
  messages: readonly PushMessage[],
  opts: SendPushOptions = {},
): Promise<PushOutcome[]> {
  if (messages.length === 0) return [];
  const doFetch = opts.fetch ?? globalThis.fetch;
  const accessToken = opts.accessToken ?? process.env.EXPO_ACCESS_TOKEN ?? null;
  const timeoutMs = opts.timeoutMs ?? EXPO_TIMEOUT_MS;

  const outcomes: PushOutcome[] = [];
  for (const batch of chunk(messages, EXPO_PUSH_CHUNK)) {
    const tickets = await postChunk(batch.map(toExpoRequest), doFetch, accessToken, timeoutMs);
    for (let i = 0; i < batch.length; i++) {
      const ticket = tickets[i] ?? {
        status: "error" as const,
        message: "Expo returned fewer tickets than messages",
      };
      outcomes.push({
        to: batch[i]!.to,
        ticket,
        deviceNotRegistered:
          ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered",
      });
    }
  }
  return outcomes;
}

/**
 * Ask Expo for the receipts of `ticketIds` (≤1000 per call, chunked here).
 * Returns only the receipts Expo has — a ticket still in flight is simply
 * absent, and the caller retries it next tick. Never throws: a failed chunk
 * yields no receipts, so nothing is disabled on a network blip.
 */
export async function getReceipts(
  ticketIds: readonly string[],
  opts: SendPushOptions = {},
): Promise<Map<string, ExpoReceipt>> {
  const receipts = new Map<string, ExpoReceipt>();
  if (ticketIds.length === 0) return receipts;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const accessToken = opts.accessToken ?? process.env.EXPO_ACCESS_TOKEN ?? null;
  const timeoutMs = opts.timeoutMs ?? EXPO_TIMEOUT_MS;

  for (const ids of chunk(ticketIds, EXPO_RECEIPT_CHUNK)) {
    try {
      const res = await doFetch(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: expoHeaders(accessToken),
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json().catch(() => null)) as
        | { data?: Record<string, ExpoReceipt>; errors?: Array<{ code?: string; message?: string }> }
        | null;
      if (!res.ok || !json || !json.data || typeof json.data !== "object") {
        const message =
          json?.errors?.map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ") ||
          `Expo receipts HTTP ${res.status}`;
        logger.error({ event: "push.expo_receipts_failed", status: res.status, message, count: ids.length });
        continue;
      }
      for (const [id, receipt] of Object.entries(json.data)) {
        if (receipt && typeof receipt === "object" && "status" in receipt) receipts.set(id, receipt);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ event: "push.expo_receipts_network_failed", message, count: ids.length });
    }
  }
  return receipts;
}

function expoHeaders(accessToken: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-encoding": "gzip, deflate",
    "content-type": "application/json",
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

async function postChunk(
  body: ExpoPushRequest[],
  doFetch: typeof fetch,
  accessToken: string | null,
  timeoutMs: number,
): Promise<ExpoTicket[]> {
  try {
    const res = await doFetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: expoHeaders(accessToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as
      | { data?: ExpoTicket[]; errors?: Array<{ code?: string; message?: string }> }
      | null;

    if (!res.ok || !json || !Array.isArray(json.data)) {
      const message =
        json?.errors?.map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ") ||
        `Expo push HTTP ${res.status}`;
      logger.error({ event: "push.expo_http_failed", status: res.status, message, count: body.length });
      return body.map(() => ({ status: "error" as const, message }));
    }
    return json.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ event: "push.expo_network_failed", message, count: body.length });
    return body.map(() => ({ status: "error" as const, message }));
  }
}
