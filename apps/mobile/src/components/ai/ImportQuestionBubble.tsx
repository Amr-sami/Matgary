import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * ImportQuestionBubble — F10.1 questions surfaced when the engine needs
 * clarification before a preview. Rendered as a stack of grouped prompts;
 * the user answers in chat and the LLM calls apply_import_correction.
 */
export function ImportQuestionBubble({ block }: { block: ai.ImportQuestionBlock }) {
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>?</Text>
        </View>
        <Text style={styles.title}>{block.title}</Text>
      </View>
      {block.questions.map((q, i) => (
        <View key={i} style={styles.question}>
          <Text numberOfLines={3} style={styles.questionText}>
            {q.message}
          </Text>
          {q.affectedRows.length > 0 ? (
            <Text style={styles.meta}>
              {q.affectedRows.length === 1
                ? `Row ${q.affectedRows[0]}`
                : `Rows: ${q.affectedRows.slice(0, 6).join(", ")}${q.affectedRows.length > 6 ? "…" : ""}`}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.warningLight,
    borderWidth: 1,
    borderColor: colors.warning,
    gap: spacing.sm,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badge: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontFamily: fonts.bold, fontSize: 16, color: colors.onAccent },
  title: { ...RTL_TEXT, flex: 1, fontFamily: fonts.bold, fontSize: 15, color: colors.warningStrong },
  question: {
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 2,
  },
  questionText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.text, lineHeight: 19 },
  meta: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
});
