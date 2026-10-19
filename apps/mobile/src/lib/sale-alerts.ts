/**
 * Sale alerts on the phone (mobile-dev-docs/16-sale-alerts.md §4-§7) — the
 * pure half, so `node --test` can load it (no imports at all).
 *
 * The server (apps/web/lib/notifications/sale-alerts.ts) sends every sale
 * push with channelId SALE_ALERT_CHANNEL and sound SALE_ALERT_SOUND; the app
 * creates that Android channel with that sound (PushRegistrar.tsx) and ships
 * the file through the expo-notifications plugin `sounds` (app.config.ts).
 * All three names must agree — sale-alert-contract.test.ts (web) and
 * src/lib/__tests__/sale-alerts.test.ts pin them.
 */

/** Android channel id. Must equal SALE_ALERT_CHANNEL on the server. */
export const SALE_ALERT_CHANNEL = "sales" as const;
/** Bundle / res/raw sound file. Must equal SALE_ALERT_SOUND on the server. */
export const SALE_ALERT_SOUND = "cha_ching.wav" as const;

/** The `sale.alert` preference row — its `push` is the per-user switch (§7). */
export const SALE_ALERT_EVENT = "sale.alert" as const;

/**
 * Push `data.type` values (§10). `preview` is the local "Play the sound"
 * notification the settings card schedules — never sent by the server.
 */
export type SaleAlertKind = "single" | "summary" | "test" | "preview";

const KIND_BY_TYPE: Record<string, SaleAlertKind> = {
  sale_alert: "single",
  sale_alert_summary: "summary",
  sale_alert_test: "test",
  sale_alert_preview: "preview",
};

export const SALE_ALERT_PREVIEW_TYPE = "sale_alert_preview";

type Data = { type?: unknown; route?: unknown } | null | undefined;

/** Which kind of sale alert a push / local notification is, or null. */
export function saleAlertKind(data: unknown): SaleAlertKind | null {
  if (!data || typeof data !== "object") return null;
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" ? KIND_BY_TYPE[type] ?? null : null;
}

/**
 * Query keys an arriving sale alert makes stale (§5): the Home dashboard
 * (`["dashboard", branchId]`) and Sales history (`["sales","history",
 * branchId]`) — prefixes, so every branch variant is invalidated. A real
 * sale (single or summary) only; the test push and the local preview did not
 * change any figure.
 */
export const SALE_ALERT_REFRESH_KEYS: readonly (readonly string[])[] = [
  ["dashboard"],
  ["sales", "history"],
];

export function refreshKeysFor(data: unknown): readonly (readonly string[])[] {
  const kind = saleAlertKind(data);
  return kind === "single" || kind === "summary" ? SALE_ALERT_REFRESH_KEYS : [];
}

/**
 * Where tapping a sale alert lands (§5), or `undefined` when `data` is not a
 * sale alert (the caller's normal routing applies).
 *  - single  → `data.route` = `/sales/<lineId>` (the sale screen);
 *  - summary / test → `/sales/history`;
 *  - a route the app cannot map → `/sales/history`, NOT the inbox: sale
 *    alerts write no inbox row, so "/notifications" would show nothing;
 *  - preview → null (the user is on the settings screen already; stay put).
 * `toAppRoute` is injected (src/lib/notification-routes.ts) so this module
 * stays import-free for `node --test`.
 */
export function saleAlertTapRoute(
  data: Data,
  toAppRoute: (path: string | null | undefined) => string | null,
): string | null | undefined {
  const kind = saleAlertKind(data);
  if (!kind) return undefined;
  if (kind === "preview") return null;
  const route = typeof data?.route === "string" ? toAppRoute(data.route) : null;
  if (route && (route === "/sales/history" || route.startsWith("/sales/"))) return route;
  return "/sales/history";
}

/**
 * The local "Play the sound" notification (§7). On Android the channel picks
 * the sound (a channel's sound wins over the content's from API 26 on), so
 * the trigger names the `sales` channel; iOS plays `content.sound` from the
 * app bundle and needs a null (immediate) trigger.
 */
export function previewNotificationRequest(
  os: string,
  copy: { title: string; body: string },
): {
  content: { title: string; body: string; sound: string; data: { type: string } };
  trigger: { channelId: string } | null;
} {
  return {
    content: {
      title: copy.title,
      body: copy.body,
      sound: SALE_ALERT_SOUND,
      data: { type: SALE_ALERT_PREVIEW_TYPE },
    },
    trigger: os === "android" ? { channelId: SALE_ALERT_CHANNEL } : null,
  };
}

/**
 * The PUT body for the switch (§7). Only `push` carries meaning; the server
 * coerces inApp/email/digestMode for `sale.alert` whatever is sent, and the
 * client sends the coerced values so the optimistic row matches the re-read.
 */
export function saleAlertPreferenceBody(push: boolean): {
  eventType: typeof SALE_ALERT_EVENT;
  inApp: false;
  push: boolean;
  email: false;
  digestMode: "instant";
} {
  return { eventType: SALE_ALERT_EVENT, inApp: false, push, email: false, digestMode: "instant" };
}

/**
 * Split the preferences GET into the sale-alert row (rendered as its own
 * card, first) and the rest (the per-event cards). `sale.alert` is listed
 * only for owners and staff with view_sales; absent → no card.
 */
export function splitSaleAlertRow<T extends { eventType: string }>(
  rows: readonly T[],
): { saleAlert: T | null; rest: T[] } {
  let saleAlert: T | null = null;
  const rest: T[] = [];
  for (const r of rows) {
    if (r.eventType === SALE_ALERT_EVENT) saleAlert = r;
    else rest.push(r);
  }
  return { saleAlert, rest };
}
