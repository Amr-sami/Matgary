import type { ComponentType } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ChartBar,
  GridFour,
  List,
  Package,
  PlusSquare,
  Receipt,
  ShoppingCart,
} from "phosphor-react-native";

import { useSession } from "@/stores/session";
import { colors, fonts, spacing } from "@/theme/tokens";

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
}

const ITEMS: NavItem[] = [
  { route: "index", label: "لوحة", icon: GridFour, requires: "view_dashboard" },
  { route: "inventory", label: "المخزن", icon: Package, requires: "view_inventory" },
  { route: "sales", label: "المبيعات", icon: ShoppingCart, requires: "view_sales" },
  { route: "add-product", label: "إضافة صنف", icon: PlusSquare, requires: "manage_inventory" },
  { route: "purchases", label: "المشتريات", icon: Receipt, requires: "view_purchases" },
  { route: "insights", label: "إحصائيات", icon: ChartBar, requires: "view_insights" },
  { route: "more", label: "المزيد", icon: List, requires: null },
];

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

  const visible = ITEMS.filter((i) => !i.requires || allowed.has(i.requires));
  const activeRoute = state.routes[state.index]?.name;

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      {visible.map((item) => {
        const isActive = item.route === activeRoute;
        const tint = isActive ? colors.accent : colors.textSecondary;
        const Icon = item.icon;
        return (
          <Pressable
            key={item.route}
            style={styles.item}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            onPress={() => {
              if (!isActive) navigation.navigate(item.route);
            }}
          >
            <Icon size={22} color={tint} />
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
