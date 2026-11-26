/**
 * Sale alerts (mobile-dev-docs/16-sale-alerts.md §2, §6): this tab's alert
 * origin, `web:<uuid v4>`, minted once per page load.
 *
 * Sent as `X-Alert-Origin` on the cart POST (live and outbox replay). The
 * server forwards a `web:` origin in the sale_alert SSE payload, and the tab
 * whose origin matches does not toast or chime for its own sale — the other
 * tabs, and every phone, still do.
 *
 * The server accepts only `/^web:[0-9a-f-]{36}$/i`, so the fallback for a
 * browser without crypto.randomUUID (an http:// LAN address is not a secure
 * context) still produces a v4-shaped UUID from getRandomValues, which works
 * everywhere.
 */
export const ALERT_ORIGIN_HEADER = "X-Alert-Origin";
export const OUTBOX_REPLAY_HEADER = "X-Outbox-Replay";

const WEB_ORIGIN_RE = /^web:[0-9a-f-]{36}$/i;

function uuidV4(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // insecure context on some browsers — fall through
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let tabOrigin: string | null = null;

/** This page load's origin. Stable until the tab reloads. */
export function getTabOrigin(): string {
  if (!tabOrigin) tabOrigin = `web:${uuidV4()}`;
  return tabOrigin;
}

/** True when `v` is a well-formed web origin (what the server would accept). */
export function isWebOrigin(v: unknown): v is string {
  return typeof v === "string" && WEB_ORIGIN_RE.test(v);
}

/** `{ "X-Alert-Origin": <this tab> }` for the live cart POST. */
export function alertOriginHeaders(): Record<string, string> {
  return { [ALERT_ORIGIN_HEADER]: getTabOrigin() };
}

/** The outbox replay adds `X-Outbox-Replay: 1` (doc 16 §1.2). */
export function outboxReplayHeaders(): Record<string, string> {
  return { ...alertOriginHeaders(), [OUTBOX_REPLAY_HEADER]: "1" };
}
