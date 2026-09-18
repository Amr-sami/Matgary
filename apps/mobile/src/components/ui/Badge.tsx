import { StyleSheet, Text, View } from "react-native";

import { colors, fonts, radius } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

/**
 * Port of the web's Badge. Measured pairs from doc 03 §2:
 *   نفذ / عاجلة  = #FDEAEA on #C0392B
 *   عادية        = #E7E6FC on #1203E3
 *   مباع         = #EAFAF1 on #27AE60
 *   low stock    = #FFEDD4 on #CA3500
 */
type Variant = "outofstock" | "lowstock" | "accent" | "success" | "neutral";

const VARIANTS: Record<Variant, { bg: string; fg: string }> = {
  outofstock: { bg: colors.dangerLight, fg: colors.danger },
  lowstock: { bg: colors.warningTint, fg: colors.warningStrong },
  accent: { bg: colors.accentLight, fg: colors.accent },
  success: { bg: colors.successLight, fg: colors.successStrong },
  neutral: { bg: colors.neutralTint, fg: colors.neutralText },
};

export function Badge({ label, variant = "neutral" }: { label: string; variant?: Variant }) {
  const v = VARIANTS[variant];
  return (
    <View style={[styles.pill, { backgroundColor: v.bg }]}>
      <Text numberOfLines={1} style={[styles.text, { color: v.fg }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.full,
    alignSelf: "flex-start",
    flexShrink: 0,
  },
  text: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 12 },
});
