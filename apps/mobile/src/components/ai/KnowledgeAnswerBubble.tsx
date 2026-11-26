import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * KnowledgeAnswerBubble — F9 grounded answer with validated citations.
 *
 * `block.sources` have all passed server-side grounding (the F9 guard
 * strips any citation the model made up). Each row shows the document title,
 * version and section — never the chunkId (not user-facing).
 */
export function KnowledgeAnswerBubble({ block }: { block: ai.KnowledgeAnswerBlock }) {
  return (
    <View style={styles.card}>
      <Text style={styles.answer}>{block.answer}</Text>
      {block.sources.length > 0 ? (
        <View style={styles.sourcesWrap}>
          <Text style={styles.sourcesTitle}>{t("mobile.insights.ai.knowledge.sources")}</Text>
          {block.sources.map((s) => (
            <View key={s.chunkId} style={styles.sourceRow}>
              <View style={styles.sourceMain}>
                <Text numberOfLines={1} style={styles.sourceTitle}>
                  {s.title}
                </Text>
                {s.section ? (
                  <Text numberOfLines={1} style={styles.sourceSection}>
                    {t("mobile.insights.ai.knowledge.section", { name: s.section })}
                  </Text>
                ) : null}
              </View>
              <View style={styles.sourceMeta}>
                <Text style={styles.version}>v{s.version}</Text>
                <View style={[styles.tierChip, tierStyleFor(s.tier)]}>
                  <Text style={styles.tierText}>{s.tier}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function tierStyleFor(tier: "HIGH" | "MEDIUM" | "LOW") {
  if (tier === "HIGH") return styles.tierHigh;
  if (tier === "MEDIUM") return styles.tierMed;
  return styles.tierLow;
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  answer: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    color: colors.text,
  },
  sourcesWrap: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  sourcesTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sourceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingVertical: 4,
  },
  sourceMain: { flex: 1, gap: 2 },
  sourceTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.text,
  },
  sourceSection: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 10,
    color: colors.textSecondary,
  },
  sourceMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  version: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 10,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  tierChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  tierText: {
    fontFamily: fonts.bold,
    fontSize: 9,
    letterSpacing: 0.5,
    color: colors.onAccent,
  },
  tierHigh: { backgroundColor: colors.successStrong },
  tierMed: { backgroundColor: colors.warning },
  tierLow: { backgroundColor: colors.textSecondary },
});
