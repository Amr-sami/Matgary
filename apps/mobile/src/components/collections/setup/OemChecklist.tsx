import { StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/ui/Button";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

import { oemSection, oemStepKeys } from "./android-steps";

/**
 * The Android `enable` step (doc 15 spec 09 §4.6.5 item 6, spec 11 §4.9): "keep TheStoro running in
 * the background", 11's steps for this phone's maker (by `expo-device` `manufacturer`: xiaomi /
 * samsung / oppo / realme, else generic), and `collection-automation-open-battery` → the module's
 * `openBatterySettings()` — the battery-optimisation LIST screen, never the direct-request dialog
 * (11 A9). The Arabic menu labels are UNVERIFIED until 11's matrix row A7.
 */
export function OemChecklist({ manufacturer, onOpenBattery }: { manufacturer: string | null; onOpenBattery: () => void }) {
  const section = oemSection(manufacturer);
  return (
    <View style={styles.gap} testID={`collection-automation-oem-${section}`}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t("mobile.collections.android.enable.heading")}
      </Text>
      <Text style={styles.body}>{t("mobile.collections.android.enable.body")}</Text>
      {oemStepKeys(section).map((k, i) => (
        <View key={k} style={styles.row}>
          <Text style={styles.num}>{`${i + 1}.`}</Text>
          <Text style={styles.text}>{t(k)}</Text>
        </View>
      ))}
      <Text style={styles.hint}>{t("mobile.collections.android.enable.stepsVary")}</Text>
      <View testID="collection-automation-open-battery" collapsable={false}>
        <Button label={t("mobile.collections.setup.install.openBattery")} variant="outline" onPress={onOpenBattery} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: spacing.md },
  heading: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 18, color: colors.text },
  body: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, color: colors.text },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: colors.textSecondary },
  row: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  num: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 22, color: colors.textSecondary, minWidth: 20 },
  text: { ...RTL_TEXT, flex: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, color: colors.text },
});
