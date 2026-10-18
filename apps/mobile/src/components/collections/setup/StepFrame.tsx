import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/ui/Button";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

import type { WizardStep } from "./wizard";

/**
 * One wizard step (doc 15 spec 09 §4.6.2): "Step n of N", the body, and a
 * footer with the primary action (wrapped as `collection-automation-next`
 * unless the step names another id) and "Finish later", which leaves the
 * wizard. The root carries `collection-automation-<step>`.
 *
 * `primary` is optional: `consent` renders its own agree / decline, and
 * `verify` its own test button.
 */
export function StepFrame({
  step,
  n,
  total,
  children,
  primary,
  onFinishLater,
}: {
  step: WizardStep;
  n: number;
  total: number;
  children: ReactNode;
  primary?: { label: string; onPress: () => void; testID?: string; disabled?: boolean; loading?: boolean };
  onFinishLater?: () => void;
}) {
  return (
    <View style={styles.root} testID={`collection-automation-${step}`} collapsable={false}>
      {step !== "unsupported" && step !== "done" ? (
        <Text style={styles.stepOf}>{t("mobile.collections.setup.stepOf", { n: String(n), total: String(total) })}</Text>
      ) : null}
      <View style={styles.body}>{children}</View>
      {primary || onFinishLater ? (
        <View style={styles.footer}>
          {primary ? (
            <View testID={primary.testID ?? "collection-automation-next"} collapsable={false}>
              <Button label={primary.label} onPress={primary.onPress} disabled={primary.disabled} loading={primary.loading} />
            </View>
          ) : null}
          {onFinishLater ? (
            <View testID="collection-automation-finish-later" collapsable={false}>
              <Button label={t("mobile.collections.setup.finishLater")} variant="ghost" onPress={onFinishLater} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.lg },
  stepOf: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary },
  body: { gap: spacing.md },
  footer: { gap: spacing.sm },
});
