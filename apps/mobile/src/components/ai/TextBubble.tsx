import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Plain-text block from the agent. Styled as the "assistant" bubble (white,
 * accent-border, bottom-left radius squared off for a chat-tail feel).
 */
export function TextBubble({ block }: { block: ai.TextBlock }) {
  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <Text style={styles.text}>{block.text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "flex-start" },
  bubble: {
    maxWidth: "92%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderBottomLeftRadius: 4,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  text: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.text,
  },
});
