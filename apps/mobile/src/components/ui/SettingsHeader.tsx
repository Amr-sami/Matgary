import type { ReactNode } from "react";
import type { Href } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { BackLink } from "@/components/ui/BackLink";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

export interface SettingsHeaderProps {
  /** Title of the screen the back link returns to — usually t("app.settingsPage.title"). */
  parentLabel: string;
  title: string;
  subtitle?: string;
  /**
   * Slot at the END of the title row: the branch chip, the bell row, an add
   * button. The title block keeps `flex: 1`, so a long title wraps instead of
   * pushing the accessory off-screen.
   */
  accessories?: ReactNode;
  /** Forwarded to BackLink; replaces the default guarded back. */
  onBack?: () => void;
  /**
   * Forwarded to BackLink: where the back tap lands with no history to pop.
   * Settings sub-screens pass "/settings" so a deep link or a locale switch
   * never strands the user. Defaults to the pathname's parent.
   */
  fallback?: Href;
  testID?: string;
}

/**
 * The one header for every settings sub-screen: BackLink, a 24pt bold title,
 * an optional 14/20 secondary subtitle — no leading icon.
 *
 * Thirteen screens carried two versions of this (26pt title + icon + 32pt back
 * vs 24pt title + 44pt back). This is the second family, which was already the
 * measured target. `marginBottom: spacing.lg` is part of the header so it
 * reads the same whether it sits inline in the scroll content or in
 * `<Screen header>`'s fixed band.
 */
export function SettingsHeader({
  parentLabel,
  title,
  subtitle,
  accessories,
  onBack,
  fallback,
  testID,
}: SettingsHeaderProps) {
  return (
    <View style={styles.root} testID={testID}>
      <BackLink label={parentLabel} onPress={onBack} fallback={fallback} />
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {accessories ? <View style={styles.accessories}>{accessories}</View> : null}
      </View>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm, marginBottom: spacing.lg },
  // Only the title shares the row with the accessory; the subtitle is a
  // full-width sibling below, so an add button or role chip never squeezes
  // the intro copy into a narrow column with an orphan last line.
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  // Stretches to the row's cross size and centres its child, so a short
  // accessory (Badge) sits on the title's optical centre instead of floating
  // at the top of Cairo's tall line box; a taller accessory (44/52pt button)
  // still top-aligns with the title block, and a wrapped title stays put.
  accessories: { alignSelf: "stretch", justifyContent: "center" },
  title: { flex: 1, minWidth: 0, fontFamily: fonts.bold, fontSize: 24, color: colors.text, ...RTL_TEXT },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
});
