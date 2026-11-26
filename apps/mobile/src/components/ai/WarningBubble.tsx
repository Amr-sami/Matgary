import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * WarningBubble — user-visible notice. Three severities (info / warning /
 * error) tint the card accent. `code` is kept off-screen and used by the
 * mobile client only for telemetry (e.g. AUDIT_WRITE_FAILED alerts ops,
 * METRIC_UNAVAILABLE is routed to a FAQ hint).
 */
export function WarningBubble({ block }: { block: ai.WarningBlock }) {
  const tone = block.severity === "error" ? toneStyles.error : block.severity === "info" ? toneStyles.info : toneStyles.warning;
  const prefix =
    block.severity === "error"
      ? t("mobile.insights.ai.warning.error")
      : block.severity === "info"
        ? t("mobile.insights.ai.warning.info")
        : t("mobile.insights.ai.warning.warning");

  return (
    <View style={[styles.card, tone.card]}>
      <View style={styles.headerRow}>
        <View style={[styles.badge, tone.badge]}>
          <Text style={[styles.badgeText, tone.badgeText]}>{prefix}</Text>
        </View>
        <Text numberOfLines={2} style={[styles.title, tone.title]}>
          {block.title}
        </Text>
      </View>
      <Text style={styles.message}>{block.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  badgeText: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 10,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  title: {
    ...RTL_TEXT,
    flex: 1,
    fontFamily: fonts.bold,
    fontSize: 14,
  },
  message: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.text,
  },
});

const toneStyles = {
  info: {
    card: { backgroundColor: colors.accentLight, borderColor: colors.accent },
    badge: { backgroundColor: colors.accent },
    badgeText: { color: colors.onAccent },
    title: { color: colors.text },
  },
  warning: {
    card: { backgroundColor: colors.warningLight, borderColor: colors.warning },
    badge: { backgroundColor: colors.warning },
    badgeText: { color: colors.onAccent },
    title: { color: colors.warningStrong },
  },
  error: {
    card: { backgroundColor: colors.dangerLight, borderColor: colors.danger },
    badge: { backgroundColor: colors.danger },
    badgeText: { color: colors.onAccent },
    title: { color: colors.danger },
  },
} as const;
