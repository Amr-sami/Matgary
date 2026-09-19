import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Icon } from "phosphor-react-native";
import { BellIcon as Bell } from "phosphor-react-native/src/icons/Bell";
import { CheckIcon as Check } from "phosphor-react-native/src/icons/Check";
import { InfoIcon as Info } from "phosphor-react-native/src/icons/Info";
import { ListChecksIcon as ListChecks } from "phosphor-react-native/src/icons/ListChecks";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { notifications, type MeResponse } from "@matgary/api-client";

type NotificationKind = notifications.NotificationKind;
type NotificationPage = notifications.NotificationPage;

import { api } from "@/api/client";
import { t } from "@/i18n";
import { useSession } from "@/stores/session";
import { MIN_TOUCH, colors, fonts, radius } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

/**
 * Port of apps/web/components/notifications/NotificationBell.tsx — the file
 * that owns the kind → icon/tone/route mapping on the web, so it owns it here
 * too; /notifications and <PushRegistrar/> import from this module rather than
 * each keeping a copy.
 *
 * Unlike the web the bell is not a dropdown: on a phone the list is a screen.
 */

/**
 * Query keys — every notification mutation invalidates the `root` prefix and
 * <PushRegistrar/> removes it on sign-out, so a second account on the same
 * phone (doc 02 §2.12's shared shop-floor device) never reads the first
 * account's badge or rows out of the cache.
 *
 * There is ONE fetch: the bell and the inbox both observe `list`. The list
 * route ignores every query param and always ships `unread` with the rows, so
 * a separate "summary" query would just download the same page twice.
 */
export const NOTIFICATION_KEYS = {
  root: ["notifications"] as const,
  list: ["notifications", "list"] as const,
};

/** The shared first-page fetch; the bell and the inbox pass the same options. */
export const NOTIFICATION_LIST_QUERY = {
  queryKey: NOTIFICATION_KEYS.list,
  queryFn: ({ pageParam }: { pageParam: string | null }) =>
    notifications.list(api, { cursor: pageParam }),
  initialPageParam: null as string | null,
  getNextPageParam: (last: NotificationPage) => last.nextCursor ?? undefined,
};

export const KIND_ICON: Record<NotificationKind, Icon> = {
  low_stock: Package,
  task_assigned: ListChecks,
  task_started: ListChecks,
  task_done: Check,
  task_updated: ListChecks,
  leave_submitted: Info,
  leave_decided: Info,
  info: Info,
};

/** Web KIND_TONE, measured pairs from the token sheet (no hex literals). */
export const KIND_TONE: Record<NotificationKind, { bg: string; fg: string }> = {
  low_stock: { bg: colors.warningTint, fg: colors.warningStrong },
  task_assigned: { bg: colors.accentLight, fg: colors.accent },
  task_started: { bg: colors.warningLight, fg: colors.warningStrong },
  task_done: { bg: colors.successLight, fg: colors.successStrong },
  task_updated: { bg: colors.accentLight, fg: colors.accent },
  leave_submitted: { bg: colors.accentLight, fg: colors.accent },
  leave_decided: { bg: colors.accentLight, fg: colors.accent },
  info: { bg: colors.neutralTint, fg: colors.neutralText },
};

/** Where a kind lands when the row carries no `link` (mirrors the producers). */
const KIND_ROUTE: Record<NotificationKind, string | null> = {
  low_stock: "/inventory",
  task_assigned: "/tasks",
  task_started: "/tasks",
  task_done: "/tasks",
  task_updated: "/tasks",
  leave_submitted: "/leave",
  leave_decided: "/leave",
  info: null,
};

/** Top-level routes under app/(app)/. A push or link outside this set is ignored. */
const KNOWN_TOP = new Set([
  "activity",
  "add-product",
  "attendance",
  "billing",
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
const HAS_DETAIL = new Set(["inventory", "customers", "suppliers", "team"]);

const SETTINGS_CHILDREN = new Set([
  "about",
  "app-lock",
  "attributes",
  "branches",
  "brands",
  "categories",
  "change-password",
  "digest",
  "notifications",
  "printers",
  "receipt",
  "security",
  "store",
]);

/**
 * Map a web `link` ("/purchases/<id>", "/inventory?low=1") or a push
 * `data.route` onto a route this app actually has. Unknown → null, so the
 * caller never pushes a path expo-router would 404 on. A detail path whose
 * screen does not exist on mobile degrades to its list ("/purchases/<id>" →
 * "/purchases").
 */
export function toAppRoute(path: string | null | undefined): string | null {
  if (!path || typeof path !== "string") return null;
  const clean = path.split("?")[0].split("#")[0].replace(/^\/\(app\)/, "");
  const segs = clean.split("/").filter(Boolean);
  if (segs.length === 0) return clean === "/" ? "/" : null;
  const [top, second] = segs;
  if (!KNOWN_TOP.has(top)) return null;
  if (second) {
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
  const top = route.split("/").filter(Boolean)[0];
  if (!top) return true;
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
  const route = toAppRoute(n.link) ?? KIND_ROUTE[n.kind] ?? null;
  if (!route) return null;
  return canOpenRoute(route, me) ? route : null;
}

export function NotificationBell() {
  const router = useRouter();
  const status = useSession((s) => s.status);

  // Observes the inbox's own query: one transfer feeds both the badge and the
  // list, and the inbox's optimistic mark-read patches move the badge too.
  const q = useInfiniteQuery({
    ...NOTIFICATION_LIST_QUERY,
    enabled: status === "signedIn",
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  if (status !== "signedIn") return null;

  const unread = q.data?.pages[0]?.unread ?? 0;
  const badge = unread > 99 ? "99+" : String(unread);
  const label =
    unread > 0
      ? t("mobile.notifications.bellUnread", { count: unread })
      : t("app.shell.notifications.title");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => router.push("/notifications")}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Bell size={22} color={unread > 0 ? colors.accent : colors.textSecondary} />
      {unread > 0 ? (
        <View style={styles.badge} pointerEvents="none">
          <Text style={styles.badgeText} numberOfLines={1}>
            {badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: colors.accentLight },
  badge: {
    position: "absolute",
    top: 4,
    end: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.full,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 10,
    lineHeight: 12,
    color: colors.bg,
  },
});
