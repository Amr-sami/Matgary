import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Icon } from "phosphor-react-native";
import { BellIcon as Bell } from "phosphor-react-native/src/icons/Bell";
import { CheckIcon as Check } from "phosphor-react-native/src/icons/Check";
import { InfoIcon as Info } from "phosphor-react-native/src/icons/Info";
import { ListChecksIcon as ListChecks } from "phosphor-react-native/src/icons/ListChecks";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { ArrowDownLeftIcon as ArrowDownLeft } from "phosphor-react-native/src/icons/ArrowDownLeft";
import { ClockIcon as Clock } from "phosphor-react-native/src/icons/Clock";
import { GaugeIcon as Gauge } from "phosphor-react-native/src/icons/Gauge";
import { ChartBarIcon as ChartBar } from "phosphor-react-native/src/icons/ChartBar";
import { WalletIcon as Wallet } from "phosphor-react-native/src/icons/Wallet";
import { WifiSlashIcon as WifiSlash } from "phosphor-react-native/src/icons/WifiSlash";
import { notifications } from "@matgary/api-client";

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
  // Digital collections (doc 15 spec 13 §4.6).
  collection_pending: Wallet,
  collection_stale: Clock,
  collection_unmatched: ArrowDownLeft,
  collection_source_silent: WifiSlash,
  collection_limit: Gauge,
  report: ChartBar,
};

/** Web KIND_TONE, measured pairs from the token sheet (no hex literals). */
export const KIND_TONE: Record<NotificationKind, { bg: string; fg: string }> = {
  // User preference: no filled background bubble around kind icons.
  low_stock: { bg: "transparent", fg: colors.warningStrong },
  task_assigned: { bg: colors.accentLight, fg: colors.accent },
  task_started: { bg: colors.warningLight, fg: colors.warningStrong },
  task_done: { bg: colors.successLight, fg: colors.successStrong },
  task_updated: { bg: colors.accentLight, fg: colors.accent },
  leave_submitted: { bg: colors.accentLight, fg: colors.accent },
  leave_decided: { bg: colors.accentLight, fg: colors.accent },
  info: { bg: colors.neutralTint, fg: colors.neutralText },
  collection_pending: { bg: colors.accentLight, fg: colors.accent },
  collection_stale: { bg: colors.warningLight, fg: colors.warningStrong },
  collection_unmatched: { bg: colors.successLight, fg: colors.successStrong },
  collection_source_silent: { bg: colors.dangerLight, fg: colors.danger },
  // Reports render the icon without the tinted circle (user preference —
  // matches the flatter Team-page row style).
  report: { bg: "transparent", fg: colors.accent },
  collection_limit: { bg: colors.warningTint, fg: colors.warningStrong },
};

// The routing registry (KIND_ROUTE, toAppRoute, canOpenRoute,
// routeForNotification) lives in src/lib/notification-routes.ts so it can be
// unit-tested with plain Node (doc 15 spec 13 §4.8); re-exported here so
// /notifications and <PushRegistrar/> keep importing from this module.
export {
  KIND_ROUTE,
  KIND_ROUTE_OVERRIDE,
  canOpenRoute,
  routeForNotification,
  toAppRoute,
} from "@/lib/notification-routes";

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
