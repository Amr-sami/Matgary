import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { GlobeIcon as Globe } from "phosphor-react-native/src/icons/Globe";

import { t, useLocale } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, MIN_TOUCH, radius, spacing } from "@/theme/tokens";

/**
 * The globe + language pill on every public screen (login, signup,
 * forgot-password, reset-password).
 *
 * ONE semantic: the pill shows the CURRENT locale, exactly like the web
 * `LangSwitcher` (`SHORT[active]`) that public__login.png was captured from —
 * "ع" while the app is in Arabic, "EN" while it is in English. Before this
 * component existed the four screens disagreed: login showed the current
 * locale, the other three hard-coded the target, so a shopkeeper switching
 * mid-flow saw the label flip meaning between screens.
 *
 * Tapping toggles ar <-> en through `useLocale().setLocale`, which re-keys the
 * root Stack (see theme/rtl.ts) — so this component reads the locale from the
 * hook at render time and keeps nothing locale-dependent in the StyleSheet.
 *
 * RTL: the globe is the first child of a row, so Yoga places it at the reading
 * start in both directions (right in Arabic, left in English) — no
 * row-reverse, no marginLeft/Right. The label uses RTL_TEXT (start-aligned).
 *
 * Accessibility: VoiceOver/TalkBack read "Language: العربية, button, Switch to
 * English" — what it is now, then what the tap does.
 */
export function LanguagePill({
  style,
  // Shared e2e contract: every public screen's pill answers to this one id.
  testID = "language-pill",
}: {
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);

  const isArabic = locale === "ar";
  const target = isArabic ? "en" : "ar";
  const shortLabel = isArabic
    ? t("app.shell.language.shortArabic")
    : t("app.shell.language.shortEnglish");
  const currentName = isArabic ? t("app.shell.language.arabic") : t("app.shell.language.english");
  const targetName = isArabic ? t("app.shell.language.english") : t("app.shell.language.arabic");

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${t("app.shell.language.label")}: ${currentName}`}
      accessibilityHint={t("mobile.languagePill.switchTo", { lang: targetName })}
      hitSlop={spacing.xs}
      onPress={() => void setLocale(target)}
      style={({ pressed }) => [styles.pill, pressed && styles.pressed, style]}
    >
      <Globe size={20} color={colors.textSecondary} />
      <Text numberOfLines={1} style={styles.label}>
        {shortLabel}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    flexShrink: 0,
  },
  pressed: { backgroundColor: colors.neutralTint },
  label: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
  },
});
