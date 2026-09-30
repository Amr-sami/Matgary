/**
 * Notification routing registry — where a notification row or a push lands in
 * the app, and whether this member may open it.
 *
 * Moved verbatim out of src/components/shell/NotificationBell.tsx (doc 15
 * spec 13 §4.8) so it is pure and testable with `node --test`: it imports
 * types only. NotificationBell.tsx re-exports everything, so /notifications
 * and <PushRegistrar/> keep their imports.
 *
 * Digital collections (spec 13 §4.8) add:
 *  - the `collections` top route (inbox, detail, credit detail) and
 *    `settings/collections` (hub, devices, automation, account form);
 *  - the inbox keeps a filtered query (`tab`, `status`, `stale`) so a stale
 *    push opens Pending + late and an unmatched push opens Credits;
 *  - KIND_ROUTE_OVERRIDE: the silent-phone alert opens the devices screen
 *    whatever web link its producer wrote (the server mirrors it as
 *    KIND_MOBILE_ROUTE_OVERRIDE, so the push `data.route` already points there);
 *  - gates: the inbox needs `view_collections`; any /settings/collections
 *    route needs `manage_collection_accounts` (not `view_settings`).
 */
import type { MeResponse, notifications } from "@matgary/api-client";

type NotificationKind = notifications.NotificationKind;

/** Where a kind lands when the row carries no `link` (mirrors the producers). */
export const KIND_ROUTE: Record<NotificationKind, string | null> = {
  low_stock: "/inventory",
  task_assigned: "/tasks",
  task_started: "/tasks",
  task_done: "/tasks",
  task_updated: "/tasks",
  leave_submitted: "/leave",
  leave_decided: "/leave",
  info: null,
  collection_pending: "/collections",
  collection_stale: "/collections",
  collection_unmatched: "/collections",
  collection_limit: "/collections",
  collection_source_silent: "/settings/collections/devices",
};

/**
 * Routes that beat the row's link (03 §B.6): the silent-phone alert links to
 * the web settings page, but on the phone it opens the devices screen.
 */
export const KIND_ROUTE_OVERRIDE: Partial<Record<NotificationKind, string>> = {
  collection_source_silent: "/settings/collections/devices",
};

/** Top-level routes under app/(app)/. A push or link outside this set is ignored. */
const KNOWN_TOP = new Set([
  "activity",
  "add-product",
  "attendance",
  "billing",
  "collections",
  "customers",
  "expenses",
  "insights",
  "inventory",
  "leave",
  "more",
  "notifications",
  "onboarding",
  "purchases",
  "returns",
  "sales",
  "settings",
  "suppliers",
  "sync",
  "tasks",
  "team",
  "whatsapp",
]);

/** Routes that have a dynamic child screen on mobile (inventory/[id] …). */
const HAS_DETAIL = new Set(["inventory", "customers", "suppliers", "team", "collections"]);

const SETTINGS_CHILDREN = new Set([
  "about",
  "app-lock",
  "attributes",
  "branches",
  "brands",
  "categories",
  "change-password",
  "collections",
  "digest",
  "notifications",
  "printers",
  "receipt",
  "security",
  "store",
]);

/** settings/collections/<x> screens that exist on mobile (09 §B.10). */
const COLLECTIONS_SETTINGS_CHILDREN = new Set(["devices", "automation"]);

/**
 * The inbox query keys the app understands (08 `parseInboxParams`), in the
 * order they are re-emitted, each with the values it may carry. Anything else
 * (e.g. the limit warning's `account`/`warning` dedupe keys) is dropped.
 */
const INBOX_QUERY: readonly (readonly [string, ReadonlySet<string>])[] = [
  ["tab", new Set(["pending", "credits", "confirmed", "rejected", "totals"])],
  ["status", new Set(["pending"])],
  ["stale", new Set(["1"])],
];

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** The inbox query, filtered to INBOX_QUERY (first value per key wins). */
function inboxQuery(query: string): string {
  const seen = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = safeDecode(eq < 0 ? pair : pair.slice(0, eq));
    const v = safeDecode(eq < 0 ? "" : pair.slice(eq + 1));
    if (!seen.has(k)) seen.set(k, v);
  }
  const out: string[] = [];
  for (const [key, allowed] of INBOX_QUERY) {
    const v = seen.get(key);
    if (v !== undefined && allowed.has(v)) out.push(`${key}=${v}`);
  }
  return out.length > 0 ? `?${out.join("&")}` : "";
}

/**
 * Map a web `link` ("/purchases/<id>", "/inventory?low=1") or a push
 * `data.route` onto a route this app actually has. Unknown → null, so the
 * caller never pushes a path expo-router would 404 on. A detail path whose
 * screen does not exist on mobile degrades to its list ("/purchases/<id>" →
 * "/purchases"). The query string is dropped, except on the collections inbox
 * (filtered to `tab|status|stale`).
 */
export function toAppRoute(path: string | null | undefined): string | null {
  if (!path || typeof path !== "string") return null;
  const noHash = path.split("#")[0];
  const qAt = noHash.indexOf("?");
  const query = qAt < 0 ? "" : noHash.slice(qAt + 1);
  const clean = (qAt < 0 ? noHash : noHash.slice(0, qAt)).replace(/^\/\(app\)/, "");
  const segs = clean.split("/").filter(Boolean);
  if (segs.length === 0) return clean === "/" ? "/" : null;
  const [top, second, third] = segs;
  if (!KNOWN_TOP.has(top)) return null;
  if (top === "collections") {
    if (!second) return `/collections${inboxQuery(query)}`;
    if (second === "credit") return third ? `/collections/credit/${third}` : "/collections";
    return `/collections/${second}`;
  }
  if (second) {
    if (top === "settings" && second === "collections") {
      if (!third) return "/settings/collections";
      if (COLLECTIONS_SETTINGS_CHILDREN.has(third)) return `/settings/collections/${third}`;
      if (third === "account" && segs[3]) return `/settings/collections/account/${segs[3]}`;
      return "/settings/collections";
    }
    if (HAS_DETAIL.has(top)) return `/${top}/${second}`;
    if (top === "settings" && SETTINGS_CHILDREN.has(second)) return `/${top}/${second}`;
    return `/${top}`;
  }
  return `/${top}`;
}

/**
 * Client-side gate per top-level route — the same table app/(app)/more.tsx
 * uses to decide which rows to show. A route not listed here (the tabs:
 * sales, inventory, insights, purchases …) is open to any signed-in member.
 * `null` = any signed-in member; a string = that permission; a function =
 * a composite rule.
 */
const ROUTE_GATE: Record<string, string | null | ((me: MeResponse) => boolean)> = {
  tasks: null,
  attendance: null,
  notifications: null,
  sync: "record_sales",
  customers: "view_customers",
  expenses: "view_expenses",
  suppliers: "view_suppliers",
  returns: "view_returns",
  activity: "view_activity_log",
  whatsapp: "manage_whatsapp",
  settings: "view_settings",
  collections: "view_collections",
  team: (me) => ["manage_team", "request_leave", "manage_leave"].some((p) => me.permissions.includes(p)),
  leave: (me) => me.permissions.includes("request_leave") || me.permissions.includes("manage_leave"),
  // Billing is owner-only on the web (app.billing.ownerOnly).
  billing: (me) => me.isOwner,
};

/**
 * Spec §8.5: "guard against the route being permission-forbidden". True when
 * `me` may open `route` (an app route from toAppRoute). A cashier tapping a
 * push about /team must land in the inbox, not on the screen's 403 state.
 */
export function canOpenRoute(route: string, me: MeResponse | null): boolean {
  if (!me) return false;
  const segs = route.split("?")[0].split("#")[0].split("/").filter(Boolean);
  const top = segs[0];
  if (!top) return true;
  // Checked before the top gate: the collections settings (hub, devices,
  // automation) are gated on the accounts permission, not on view_settings
  // (09's hub gate).
  if (top === "settings" && segs[1] === "collections") {
    return me.isOwner || me.permissions.includes("manage_collection_accounts");
  }
  const gate = ROUTE_GATE[top];
  if (gate === undefined || gate === null) return true;
  if (typeof gate === "function") return gate(me);
  return me.isOwner || me.permissions.includes(gate);
}

/**
 * The route a tapped inbox row should open, or null for a dead-end row —
 * including a row whose target `me` is not allowed to open (the row is then
 * read-only: tapping marks it read and goes nowhere).
 */
export function routeForNotification(
  n: { kind: NotificationKind; link: string | null },
  me: MeResponse | null,
): string | null {
  const route = KIND_ROUTE_OVERRIDE[n.kind] ?? toAppRoute(n.link) ?? KIND_ROUTE[n.kind] ?? null;
  if (!route) return null;
  return canOpenRoute(route, me) ? route : null;
}
