/**
 * Sale alerts (doc 16 §2): the device that recorded a sale must not chime for
 * it. Every POST /api/sales/cart from this app — the live call and the outbox
 * replay — carries `X-Alert-Origin: <this install's Expo push token>`; the
 * server drops exactly that token from the fan-out, so this phone stays
 * silent while the seller's other devices and the rest of the shop ring.
 *
 * Pure (no store import) so `node --test` can load it; call sites pass
 * `usePush.getState().token`. With no token (simulator, denied permission,
 * not minted yet) the header is omitted — there is nothing to exclude.
 *
 * The shape check mirrors the server's isExpoPushToken (the server re-checks
 * and ignores anything else); it only keeps junk off the wire.
 */
export const ALERT_ORIGIN_HEADER = "X-Alert-Origin";
export const OUTBOX_REPLAY_HEADER = "X-Outbox-Replay";

const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]{1,256}\]$/;

export function alertOriginHeader(token: string | null | undefined): Record<string, string> {
  const t = typeof token === "string" ? token.trim() : "";
  return EXPO_TOKEN_RE.test(t) ? { [ALERT_ORIGIN_HEADER]: t } : {};
}

/** Headers for an outbox replay: the origin (if any) plus `X-Outbox-Replay: 1`. */
export function outboxReplayHeaders(token: string | null | undefined): Record<string, string> {
  return { ...alertOriginHeader(token), [OUTBOX_REPLAY_HEADER]: "1" };
}
