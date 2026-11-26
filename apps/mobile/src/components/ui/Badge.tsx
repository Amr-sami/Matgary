import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, fonts, radius } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

/**
 * Port of the web's Badge. Measured pairs from doc 03 §2:
 *   نفذ / عاجلة  = #FDEAEA on #C0392B
 *   عادية        = #E7E6FC on #1203E3
 *   مباع         = #EAFAF1 on #27AE60
 *   low stock    = #FFEDD4 on #CA3500
 *
 * Alignment contract: the pill shrink-wraps its label but does NOT pick its
 * own cross-axis position — the parent's `alignItems` does. In a
 * `flexDirection:"row"` with alignItems:"center" it sits on the row's
 * centreline next to the avatar and chevron; in a trailing column with
 * alignItems:"flex-end" it shares the amount's edge. The old
 * `alignSelf:"flex-start"` on the pill overrode both, pinning it to the top
 * of centred rows and the START edge of end-aligned columns (ragged in Arabic,
 * where the amount and the pill differ in width).
 *
 * Two Views make that possible: the outer one takes the parent's alignment
 * (alignSelf:"auto") and, if the parent stretches it — a plain column, a
 * wrapping pill row — turns invisibly wide/tall while the inner pill stays
 * hugged to its text at the start, which is what the pill did before.
 */
type Variant = "outofstock" | "lowstock" | "accent" | "success" | "neutral";

const VARIANTS: Record<Variant, { bg: string; fg: string }> = {
  outofstock: { bg: colors.dangerLight, fg: colors.danger },
  lowstock: { bg: colors.warningTint, fg: colors.warningStrong },
  accent: { bg: colors.accentLight, fg: colors.accent },
  success: { bg: colors.successLight, fg: colors.successStrong },
  neutral: { bg: colors.neutralTint, fg: colors.neutralText },
};

export function Badge({
  label,
  variant = "neutral",
  style,
}: {
  label: string;
  variant?: Variant;
  /** Outer-box style — for `alignSelf` overrides or margins; the pill itself is fixed. */
  style?: ViewStyle;
}) {
  const v = VARIANTS[variant];
  return (
    <View style={[styles.box, style]}>
      <View style={[styles.pill, { backgroundColor: v.bg }]}>
        <Text numberOfLines={1} style={[styles.text, { color: v.fg }]}>
          {label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Row + flex-start: the pill hugs its text along both axes even when the
  // parent stretches this box, so a Badge never becomes a full-width bar.
  box: { flexDirection: "row", alignItems: "flex-start", flexShrink: 0 },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  text: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 12 },
});
