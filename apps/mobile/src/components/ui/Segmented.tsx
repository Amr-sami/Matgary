import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

/**
 * The tab strip at the top of Insights: a bordered container with the active
 * item as a white pill lifted by shadow-sm — `rounded-xl` outer, per doc 03 §6.
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.wrap}>
      {items.map((it) => {
        const active = it.key === value;
        return (
          <Pressable
            key={it.key}
            onPress={() => onChange(it.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.item, active && styles.itemActive]}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              style={[styles.label, active ? styles.labelActive : styles.labelInactive]}
            >
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    gap: spacing.xs,
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  // Content-sized cells that share the leftover width (the web's `shrink-0
  // px-3.5` strip), not equal columns: a long label such as the team tab's
  // "الفريق والصلاحيات" would otherwise be squeezed into a quarter and
  // auto-shrunk below its siblings. adjustsFontSizeToFit stays as the last
  // resort for narrow devices.
  item: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
  },
  itemActive: { backgroundColor: colors.card, ...elevation.card },
  label: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14 },
  labelActive: { ...RTL_TEXT, color: colors.text, fontFamily: fonts.semibold },
  labelInactive: { color: colors.textSecondary },
});
