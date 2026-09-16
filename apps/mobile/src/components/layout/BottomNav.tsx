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

import { colors, fonts, spacing } from "@/theme/tokens";

/**
 * Port of apps/web/components/layout/MobileBottomNav.tsx.
 *
 * Same six primary destinations, same order, same icons (Phosphor, regular
 * weight — the web aliases them under lucide names in lib/icons.ts), plus the
 * More entry. The active tab is accent-coloured with a short underline.
 *
 * Items are filtered by permission exactly as the web does, so a cashier sees
 * a shorter bar rather than tabs that 403 on tap. Doc 05 argued for trimming
 * this to five tabs on native; that is a design change, not a port, so it is
 * deliberately NOT made here — the brief is to match the shipped UI.
 */
type PhosphorIcon = ComponentType<{ size?: number; color?: string }>;

interface NavItem {
  key: string;
  label: string;
  icon: PhosphorIcon;
  requires: string | null;
}

const PRIMARY: NavItem[] = [
  { key: "dashboard", label: "لوحة", icon: GridFour, requires: "view_dashboard" },
  { key: "inventory", label: "المخزن", icon: Package, requires: "view_inventory" },
  { key: "sales", label: "المبيعات", icon: ShoppingCart, requires: "view_sales" },
  { key: "add-product", label: "إضافة صنف", icon: PlusSquare, requires: "manage_inventory" },
  { key: "purchases", label: "المشتريات", icon: Receipt, requires: "view_purchases" },
  { key: "insights", label: "إحصائيات", icon: ChartBar, requires: "view_insights" },
];

const MORE: NavItem = { key: "more", label: "المزيد", icon: List, requires: null };

interface BottomNavProps {
  active: string;
  permissions: string[];
  onSelect?: (key: string) => void;
}

export function BottomNav({ active, permissions, onSelect }: BottomNavProps) {
  const insets = useSafeAreaInsets();
  const allowed = new Set(permissions);
  const items = [
    ...PRIMARY.filter((i) => !i.requires || allowed.has(i.requires)),
    MORE,
  ];

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      {items.map((item) => {
        const isActive = item.key === active;
        const tint = isActive ? colors.accent : colors.textSecondary;
        const Icon = item.icon;
        return (
          <Pressable
            key={item.key}
            style={styles.item}
            onPress={() => onSelect?.(item.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
          >
            <Icon size={22} color={tint} />
            <Text numberOfLines={1} style={[styles.label, { color: tint }]}>
              {item.label}
            </Text>
            {isActive ? <View style={styles.underline} /> : null}
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
  item: {
    flex: 1,
    alignItems: "center",
    gap: 4,
    // 44px minimum target — the web still has 348 controls under this.
    minHeight: 44,
  },
  label: { fontFamily: fonts.medium, fontSize: 10 },
  underline: {
    height: 2,
    width: 24,
    borderRadius: 2,
    backgroundColor: colors.accent,
    marginTop: 2,
  },
});
