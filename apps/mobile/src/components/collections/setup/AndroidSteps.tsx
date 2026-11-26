import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/ui/Button";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

import { ANDROID_INSTALL_NOTE_KEYS, ANDROID_TROUBLESHOOT_KEYS, noneInstalled, type AppRow } from "./android-steps";

/**
 * Spec 11's Android copy laid out for 09's wizard (doc 15 spec 09 §4.6.5 `android_listener`, step
 * 19). `phase="install"`: the notification-access explainer and Android's own warning, the
 * `collection-automation-open-access` button (→ the module's `openAccessSettings()`, which the
 * native side refuses before `configure()`), the connected line, then the bank / wallet apps of the
 * scoped accounts with installed / missing, and the static notes. `phase="troubleshoot"`: 11's list
 * under `verify.timeout`. The copy is 11's (`mobile.collections.android.*`); this only lays it out.
 */
export function AndroidSteps(
  props:
    | {
        phase: "install";
        delivering: boolean;
        accessGranted: boolean | null;
        connected: boolean;
        rows: readonly AppRow[];
        onOpenAccess: () => void;
        error?: string | null;
      }
    | { phase: "troubleshoot" },
) {
  if (props.phase === "troubleshoot") {
    return (
      <View style={styles.gap} testID="collection-automation-android-troubleshoot">
        <Text style={styles.sub}>{t("mobile.collections.android.troubleshoot.title")}</Text>
        {ANDROID_TROUBLESHOOT_KEYS.map((k) => (
          <Text key={k} style={styles.body}>{`• ${t(k)}`}</Text>
        ))}
      </View>
    );
  }
  const { delivering, accessGranted, connected, rows, onOpenAccess, error } = props;
  return (
    <View style={styles.gap} testID="collection-automation-android-install">
      <Text accessibilityRole="header" style={styles.heading}>
        {t("mobile.collections.android.install.heading")}
      </Text>
      <Text style={styles.body}>{t("mobile.collections.android.install.body")}</Text>
      <Text style={styles.hint}>{t("mobile.collections.android.install.systemWarning")}</Text>

      {delivering ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <View testID="collection-automation-open-access" collapsable={false}>
          <Button
            label={t("mobile.collections.setup.install.openAccess")}
            variant={accessGranted ? "outline" : "primary"}
            onPress={onOpenAccess}
            disabled={!!error}
          />
        </View>
      )}

      {accessGranted != null && !delivering ? (
        <Text
          style={[styles.body, connected ? styles.ok : styles.warn]}
          testID={connected ? "collection-automation-android-connected" : "collection-automation-android-not-connected"}
        >
          {connected ? t("mobile.collections.setup.install.connected") : t("mobile.collections.setup.install.notConnected")}
        </Text>
      ) : null}

      {error ? <Text style={[styles.body, styles.err]}>{error}</Text> : null}

      <Text style={styles.sub}>{t("mobile.collections.android.install.appsHeading")}</Text>
      {rows.map((r) => (
        <Text
          key={r.pkg}
          style={[styles.body, r.installed ? styles.ok : null]}
          testID={`collection-automation-android-app-${r.installed ? "installed" : "missing"}`}
        >
          {`• ${t(r.key, { app: t(r.labelKey) })}`}
        </Text>
      ))}
      {noneInstalled(rows) ? <Text style={[styles.body, styles.warn]}>{t("mobile.collections.android.install.noneInstalled")}</Text> : null}

      {ANDROID_INSTALL_NOTE_KEYS.map((k) => (
        <Text key={k} style={styles.hint}>
          {t(k)}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: spacing.md },
  heading: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 18, color: colors.text },
  sub: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, color: colors.text },
  body: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, color: colors.text },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: colors.textSecondary },
  ok: { color: colors.successStrong, fontFamily: fonts.semibold },
  warn: { color: colors.warningStrong },
  err: { color: colors.danger },
});
