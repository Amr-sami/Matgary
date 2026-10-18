import { StyleSheet, Text, View } from "react-native";

import { iosStepKeys, type IosMode, type IosPhase, type IosVariant } from "@/collections/ios/steps";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

/**
 * Spec 10's iOS instructions as numbered rows (doc 15 spec 09 §4.6.5, 10
 * §4.12): `iosStepKeys({phase, mode, variant, iosMajor})` in order, each
 * rendered with `t(key, params)`. `mode` = `"intent"` on the App Intent path
 * (M3), else `"http"`. The copy is 10's (`mobile.collections.ios.*`); this
 * component only lays it out.
 */
export function IosSteps({
  phase,
  mode,
  variant,
  iosMajor,
  testID,
}: {
  phase: IosPhase;
  mode: IosMode;
  variant: IosVariant;
  iosMajor: number;
  testID?: string;
}) {
  const steps = iosStepKeys({ phase, mode, variant, iosMajor });
  return (
    <View style={styles.list} testID={testID ?? `collection-automation-ios-${phase}`}>
      {steps.map((s, i) => (
        <View key={s.key} style={styles.row}>
          <Text style={styles.num}>{`${i + 1}.`}</Text>
          <Text style={styles.text}>{t(s.key, s.params)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  row: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  num: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 22, color: colors.textSecondary, minWidth: 20 },
  text: { ...RTL_TEXT, flex: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, color: colors.text },
});
