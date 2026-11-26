import type { Href } from "expo-router";
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";

import { ChevronBack } from "@/components/ui/Chevron";
import { t } from "@/i18n";
import { useGoBack } from "@/lib/nav";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

export interface BackLinkProps {
  /**
   * The PARENT screen's title — "‹ Settings", "‹ Products". Never a generic
   * "Back" and never a "Parent › Current" crumb: the one back affordance
   * app-wide names where the tap goes.
   */
  label: string;
  /** Replaces the default guarded back. Pass a step-back for wizards. */
  onPress?: () => void;
  /**
   * Where the tap lands when there is no history to pop — a cold-start deep
   * link, a push-notification tap, the locale re-key. Defaults to the current
   * pathname's parent; pass the real parent whenever the label names a screen
   * the URL does not ("‹ Sales history" from /sales/[id]).
   */
  fallback?: Href;
  /** Defaults to "back-link" — the e2e contract for every back affordance. */
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * The app's one back affordance: a 16pt direction-aware chevron and the
 * parent's title, 44pt tall, hugging the reading edge.
 *
 * Twenty-one screens used to hand-roll this with four chevron sizes and three
 * heights. The row is shrink-wrapped (`alignSelf: "flex-start"`) so only the
 * glyph + label are tappable; `marginStart -4 / paddingStart 4` pulls the
 * chevron's visual edge flush with the content column while the pressed tint
 * still gets a little bleed into the gutter. `ChevronBack` picks the caret from
 * the live locale, so nothing here reads the locale itself.
 *
 * The tap is `useGoBack(fallback)`, never a bare `router.back()`: with no
 * history (deep link, push tap, locale switch) a bare back is a silent no-op.
 */
export function BackLink({ label, onPress, fallback, testID = "back-link", style }: BackLinkProps) {
  const goBack = useGoBack(fallback);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("app.common.back")}
      accessibilityHint={label}
      onPress={onPress ?? goBack}
      hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
      testID={testID}
      style={({ pressed }) => [styles.link, pressed && styles.pressed, style]}
    >
      <ChevronBack size={16} color={colors.textSecondary} />
      <Text numberOfLines={1} style={styles.label}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    marginStart: -spacing.xs,
    paddingStart: spacing.xs,
    paddingEnd: spacing.sm,
    borderRadius: radius.md,
  },
  pressed: { backgroundColor: colors.neutralTint },
  label: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
    flexShrink: 1,
  },
});
