import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/ui/Button";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

import { AndroidSteps } from "./AndroidSteps";
import { IosSteps } from "./IosSteps";
import type { IosVariantId } from "./wizard";

export type VerifyState = "idle" | "waiting" | "ok" | "timeout";

/**
 * The `verify` step body (doc 15 spec 09 §4.6.7). "Send test"
 * (`collection-automation-test`) is the caller's: it reads the baseline,
 * runs the shortcut by name with the marker, and polls. This shows the
 * state — waiting, ok, or timeout with the frame check and 10's
 * troubleshooting list (11's on Android, M4) — and, in `__DEV__` only, the simulate button
 * (`collection-automation-test-simulate`; stripped from release, doc 14
 * §6.3). Never shows `done` itself: the caller moves on only after `ok`.
 */
export function VerifyStep({
  state,
  onSend,
  onSimulate,
  mode,
  variant,
  iosMajor,
  error,
  platform = "ios",
}: {
  platform?: "ios" | "android";
  state: VerifyState;
  onSend: () => void;
  onSimulate?: () => void;
  mode: "http" | "intent";
  variant: IosVariantId;
  iosMajor: number;
  error?: string | null;
}) {
  const waiting = state === "waiting";
  return (
    <View style={styles.gap}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t("mobile.collections.setup.verify.heading")}
      </Text>
      <Text style={styles.body}>
        {platform === "android" ? t("mobile.collections.setup.verify.bodyAndroid") : t("mobile.collections.setup.verify.body")}
      </Text>

      <View testID="collection-automation-test" collapsable={false}>
        <Button
          label={state === "timeout" ? t("mobile.collections.setup.verify.retry") : t("mobile.collections.setup.verify.send")}
          onPress={onSend}
          disabled={waiting}
        />
      </View>

      {waiting ? (
        <View style={styles.row} testID="collection-automation-verify-waiting">
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.body}>{t("mobile.collections.setup.verify.waiting")}</Text>
        </View>
      ) : null}

      {state === "ok" ? (
        <Text style={[styles.body, styles.ok]} testID="collection-automation-verify-ok">
          {t("mobile.collections.setup.verify.ok")}
        </Text>
      ) : null}

      {state === "timeout" ? (
        <View style={styles.gap} testID="collection-automation-verify-timeout">
          <Text style={[styles.body, styles.err]}>{t("mobile.collections.setup.verify.timeout")}</Text>
          <Text style={styles.sub}>{t("mobile.collections.setup.verify.checks.title")}</Text>
          <Text style={styles.body}>{`• ${t("mobile.collections.setup.verify.checks.online")}`}</Text>
          {platform === "android" ? (
            <AndroidSteps phase="troubleshoot" />
          ) : (
            <IosSteps phase="troubleshoot" mode={mode} variant={variant} iosMajor={iosMajor} />
          )}
        </View>
      ) : null}

      {error ? <Text style={[styles.body, styles.err]}>{error}</Text> : null}

      {__DEV__ && onSimulate ? (
        <View testID="collection-automation-test-simulate" collapsable={false}>
          <Button label={t("mobile.collections.setup.dev.simulateTest")} variant="outline" onPress={onSimulate} disabled={state === "ok"} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: spacing.md },
  row: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  heading: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 18, color: colors.text },
  sub: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, color: colors.text },
  body: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, color: colors.text },
  ok: { color: colors.successStrong, fontFamily: fonts.semibold },
  err: { color: colors.danger },
});
