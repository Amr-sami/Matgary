import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * ClarificationBubble — "which one did you mean?" picker.
 *
 * Tapping an option fires `onFollowUp(option.followUpText)` which the chat
 * screen pushes through the same `send()` path a typed message uses. That
 * means F6 context + F5 preview run unchanged — the clarification option is
 * just a convenience over typing the follow-up in full.
 *
 * Grounding is enforced server-side (apps/web/lib/ai/grounding.ts): every
 * `entityId` in the options list was returned by a data tool on that turn.
 */
export interface ClarificationBubbleProps {
  block: ai.ClarificationBlock;
  onFollowUp?: (text: string) => void;
}

export function ClarificationBubble({ block, onFollowUp }: ClarificationBubbleProps) {
  const [tapped, setTapped] = useState<string | null>(null);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{block.title}</Text>
      <Text style={styles.prompt}>
        {block.prompt ?? t("mobile.insights.ai.clarification.pickOne")}
      </Text>
      <View style={styles.list}>
        {block.options.map((opt) => {
          const chosen = tapped === opt.entityId;
          return (
            <Pressable
              key={opt.entityId}
              disabled={tapped !== null}
              onPress={() => {
                setTapped(opt.entityId);
                onFollowUp?.(opt.followUpText);
              }}
              accessibilityRole="button"
              accessibilityLabel={opt.label}
              style={({ pressed }) => [
                styles.option,
                pressed && styles.optionPressed,
                chosen && styles.optionChosen,
                tapped !== null && !chosen && styles.optionMuted,
              ]}
            >
              <Text numberOfLines={2} style={styles.optionLabel}>
                {opt.label}
              </Text>
              {opt.hint ? (
                <Text numberOfLines={1} style={styles.optionHint}>
                  {opt.hint}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {tapped ? (
        <Text style={styles.footerStatus}>
          {t("mobile.insights.ai.clarification.selected", {
            label: block.options.find((o) => o.entityId === tapped)?.label ?? "",
          })}
        </Text>
      ) : null}
    </View>
  );
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
  title: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
  },
  prompt: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
  },
  list: { gap: spacing.xs, marginTop: spacing.xs },
  option: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accentLight,
    backgroundColor: colors.card,
    gap: 2,
  },
  optionPressed: { backgroundColor: colors.accentLight },
  optionChosen: {
    borderColor: colors.accent,
    backgroundColor: colors.accentLight,
  },
  optionMuted: { opacity: 0.45 },
  optionLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  optionHint: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
  },
  footerStatus: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 11,
    color: colors.accent,
    marginTop: spacing.xs,
  },
});
