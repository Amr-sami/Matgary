import { useEffect, type ComponentType } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import {
  ChartBar,
  GridFour,
  List,
  Package,
  PlusSquare,
  Receipt,
  ShoppingCart,
} from "phosphor-react-native";

import { api } from "@/api/client";
import { UNREAD_TASKS_KEY, badgeText, useBadges } from "@/stores/badges";
import { useSession } from "@/stores/session";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of apps/web/components/layout/MobileBottomNav.tsx.
 *
 * Same destinations, same order, same Phosphor glyphs (the web aliases them
 * under lucide names in lib/icons.ts), and the same permission filtering — a
 * cashier gets a shorter bar rather than tabs that 403 on tap.
 *
 * Doc 05 argues for trimming this to five tabs on native. That is a design
 * change rather than a port, so it is deliberately NOT made here.
 */
type PhosphorIcon = ComponentType<{ size?: number; color?: string }>;

interface NavItem {
  /** expo-router route name under (app). */
  route: string;
  label: string;
  icon: PhosphorIcon;
  requires: string | null;
  /** Which badge count this tab carries, if any. Tasks lives under More. */
  badge?: "tasksUnread";
}

const ITEMS = (): NavItem[] => ([
  { route: "index", label: t("app.shell.primary.dashboardShort"), icon: GridFour, requires: "view_dashboard" },
  { route: "inventory", label: t("app.shell.primary.inventory"), icon: Package, requires: "view_inventory" },
  { route: "sales", label: t("app.shell.primary.sales"), icon: ShoppingCart, requires: "view_sales" },
  { route: "add-product", label: t("app.shell.primary.addProduct"), icon: PlusSquare, requires: "manage_inventory" },
  { route: "purchases", label: t("app.shell.primary.purchases"), icon: Receipt, requires: "view_purchases" },
  { route: "insights", label: t("app.shell.primary.insights"), icon: ChartBar, requires: "view_insights" },
  { route: "more", label: t("app.shell.more"), icon: List, requires: null, badge: "tasksUnread" },
]);

/**
 * Structural props rather than `BottomTabBarProps`.
 *
 * expo-router bundles its own copy of @react-navigation/bottom-tabs, so the
 * hoisted types and the ones expo-router passes are two different nominal types
 * and never assignable to each other. This component only needs the active
 * route name and a way to navigate, so declaring exactly that sidesteps the
 * dual-package problem instead of casting around it.
 */
interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: { navigate: (name: string) => void };
}

export function BottomNav({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const permissions = useSession((s) => s.me?.permissions);
  const allowed = new Set(permissions ?? []);

  // Doc 02 §1.1 row 14 / web MobileBottomNav: the badge is the web's
  // useUnreadTaskCount — GET /api/tasks/unread-count, tasks assigned to me that
  // I have not seen, cleared by the tasks screen POSTing /api/tasks/seen. Not
  // the length of GET /api/tasks: a manager sees every task in the branch
  // there, and a permanent "9+" for other people's standing work says nothing.
  // requireTenant-only, so every signed-in user may ask.
  const unreadQuery = useQuery({
    queryKey: UNREAD_TASKS_KEY,
    queryFn: () => api.request<{ count: number }>("/api/tasks/unread-count"),
    enabled: permissions !== undefined,
    // Web parity (hooks/useUnreadTaskCount.ts): poll every minute while the
    // app is in the foreground. This bar is mounted for the whole session, so
    // its observer never remounts — without the interval the badge only moved
    // on app-foreground, reconnect, branch switch or the tasks screen's own
    // mutations, and a task assigned from the web stayed invisible.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const setTasksUnread = useBadges((s) => s.setTasksUnread);
  useEffect(() => {
    if (unreadQuery.data) setTasksUnread(unreadQuery.data.count);
  }, [unreadQuery.data, setTasksUnread]);
  // Sign-out unmounts the (app) group (root Stack.Protected) and this bar with
  // it. SnapshotRefresher clears the TanStack cache then, but not this store,
  // so drop the count here or the next account inherits it until its own
  // first fetch answers — indefinitely, if that fetch fails offline.
  useEffect(() => () => useBadges.getState().reset(), []);
  const tasksUnread = useBadges((s) => s.tasksUnread);

  const visible = ITEMS().filter((i) => !i.requires || allowed.has(i.requires));
  const activeRoute = state.routes[state.index]?.name;

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      {visible.map((item) => {
        const isActive = item.route === activeRoute;
        const tint = isActive ? colors.accent : colors.textSecondary;
        const Icon = item.icon;
        const count = item.badge === "tasksUnread" ? tasksUnread : 0;
        return (
          <Pressable
            key={item.route}
            style={styles.item}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={count > 0 ? `${item.label}, ${count} ${t("app.shell.newItems")}` : item.label}
            onPress={() => {
              if (!isActive) navigation.navigate(item.route);
            }}
          >
            <View style={styles.iconWrap}>
              <Icon size={22} color={tint} />
              {count > 0 ? (
                <View style={styles.badge} pointerEvents="none">
                  <Text style={styles.badgeText}>{badgeText(count)}</Text>
                </View>
              ) : null}
            </View>
            <Text numberOfLines={1} style={[styles.label, { color: tint }]}>
              {item.label}
            </Text>
            <View style={[styles.underline, !isActive && styles.underlineHidden]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-around",
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  item: { flex: 1, alignItems: "center", gap: 4, minHeight: 44 },
  iconWrap: { position: "relative" },
  // Web parity: `-top-1.5 -end-2` on a 16px danger pill. `end` (not `right`)
  // so it sits past the glyph's trailing edge under the root RTL direction.
  badge: {
    position: "absolute",
    top: -5,
    end: -9,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: radius.full,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontFamily: fonts.bold,
    fontSize: 9,
    lineHeight: 12,
    color: colors.onAccent,
    // Digits in a pill: the count is a number, not a sentence.
    writingDirection: "ltr",
  },
  label: { fontFamily: fonts.medium, fontSize: 10 },
  underline: {
    height: 2,
    width: 24,
    borderRadius: 2,
    backgroundColor: colors.accent,
    marginTop: 2,
  },
  // Kept mounted so the label never shifts when the active tab changes.
  underlineHidden: { opacity: 0 },
});
