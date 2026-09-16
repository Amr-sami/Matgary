import { StyleSheet, Text, View } from "react-native";

import { colors, fonts } from "@/theme/tokens";

/**
 * "ستورو" with the diagonal-cut S mark.
 *
 * The real mark is an SVG whose upper half is red (#E8112D) and lower half
 * accent blue, cut on a diagonal so it reads as both an "S" and a sales arrow.
 * That asset has not been ported yet, so this approximates it with two clipped
 * halves of the same glyph — close enough to hold the composition, and flagged
 * so it gets replaced with the real path rather than quietly shipping.
 *
 * TODO(phase-4): replace with the traced SVG from apps/web/public.
 */
export function Wordmark({ size = 40 }: { size?: number }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.word, { fontSize: size }]}>ستورو</Text>
      <View style={{ width: size * 0.9, height: size * 1.1 }}>
        <View style={styles.markTop}>
          <Text style={[styles.mark, { fontSize: size * 1.1, color: "#E8112D" }]}>
            S
          </Text>
        </View>
        <View style={styles.markBottom}>
          <Text
            style={[
              styles.mark,
              { fontSize: size * 1.1, color: colors.accent, top: -size * 0.55 },
            ]}
          >
            S
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 6,
  },
  word: {
    fontFamily: fonts.bold,
    color: colors.accent,
    includeFontPadding: false,
  },
  mark: {
    fontFamily: fonts.bold,
    fontStyle: "italic",
    position: "absolute",
    right: 0,
  },
  markTop: { height: "50%", overflow: "hidden" },
  markBottom: { height: "50%", overflow: "hidden" },
});
