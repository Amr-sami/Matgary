import { Pressable, StyleSheet, Text, View } from "react-native";

import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

/**
 * The tab strip at the top of Insights: a bordered container with the active
 * item as a white pill lifted by shadow-sm — `rounded-xl` outer, per doc 03 §6.
 *
 * Each item is ONE accessibility element: the Pressable carries the role
 * ("tab"), the selected state and the label; its Text is `accessible={false}`
 * so it is folded into the parent instead of appearing as a sibling node. A
 * driver that looks an element up by its text (Maestro `tapOn: "…"`, VoiceOver)
 * therefore lands on the tab itself — the whole hit area — not on a
 * text-only child whose frame `adjustsFontSizeToFit` may have shrunk.
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
}: {
  /** `testID` is optional and per item (e.g. settings' "language-ar"/"language-en"). */
  items: { key: T; label: string; testID?: string }[];
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
            testID={it.testID}
            onPress={() => onChange(it.key)}
            accessible
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={it.label}
            style={[styles.item, active && styles.itemActive]}
          >
            <Text
              accessible={false}
              importantForAccessibility="no"
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
  // Every item grows and shrinks, so the strip is always fully covered by
  // Pressables (no dead gaps) and each one is at least MIN_TOUCH tall. The
  // basis stays content-sized rather than `flex: 1`'s zero: equal columns
  // would squeeze a long label such as the team tab's "الفريق والصلاحيات"
  // into a quarter and auto-shrink it below its siblings (the web's
  // `shrink-0 px-3.5` strip shares leftover width the same way).
  // adjustsFontSizeToFit remains the last resort for narrow devices.
  item: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minHeight: MIN_TOUCH,
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
