import type { ReactNode } from "react";
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
  /** Forwarded to BackLink; defaults to `router.back()`. */
  onBack?: () => void;
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
  testID,
}: SettingsHeaderProps) {
  return (
    <View style={styles.root} testID={testID}>
      <BackLink label={parentLabel} onPress={onBack} />
      <View style={styles.titleRow}>
        <View style={styles.titleText}>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {accessories ?? null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm, marginBottom: spacing.lg },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  titleText: { flex: 1, minWidth: 0, gap: spacing.xs },
  title: { fontFamily: fonts.bold, fontSize: 24, color: colors.text, ...RTL_TEXT },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
});
