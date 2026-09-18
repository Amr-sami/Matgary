import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  StyleSheet,
  Text,
  View, ScrollView
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as LocalAuthentication from "expo-local-authentication";
import { AuthenticationType, SecurityLevel } from "expo-local-authentication";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { LockKeyIcon as LockKey } from "phosphor-react-native/src/icons/LockKey";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";

import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { ToggleRow } from "@/components/ui/ToggleRow";
import {
  REQUIRE_AFTER_OPTIONS,
  type RequireAfterSeconds,
  useAppLock,
} from "@/stores/appLock";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Settings → App lock (doc 06 §7.4).
 *
 * Three cards: the switch, the "require after" chips, and what this device
 * can actually do. The last one exists because the failure modes are all
 * device-side — no Face ID enrolled, no passcode set — and a switch that
 * silently refuses to turn on is the worst version of that. The capability
 * probe is a query so a device that throws (some Android OEM builds do)
 * renders a "could not check" line instead of a red screen.
 *
 * Turning the lock ON runs one real `authenticateAsync` first: the user
 * proves the device can unlock before we start trusting it to.
 */

interface Capabilities {
  hasHardware: boolean;
  types: AuthenticationType[];
  enrolled: boolean;
  level: SecurityLevel;
}

async function probe(): Promise<Capabilities> {
  const [hasHardware, types, enrolled, level] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.getEnrolledLevelAsync(),
  ]);
  return { hasHardware, types, enrolled, level };
}

/** "Face ID", "Touch ID", "Fingerprint / Face unlock" — platform-correct names. */
function methodLabel(types: AuthenticationType[]): string {
  if (types.length === 0) return t("mobile.appLock.noBiometrics");
  const ios = Platform.OS === "ios";
  const names = types.map((type) => {
    switch (type) {
      case AuthenticationType.FACIAL_RECOGNITION:
        return ios ? t("mobile.appLock.faceId") : t("mobile.appLock.face");
      case AuthenticationType.FINGERPRINT:
        return ios ? t("mobile.appLock.touchId") : t("mobile.appLock.fingerprint");
      case AuthenticationType.IRIS:
        return t("mobile.appLock.iris");
      default:
        return null;
    }
  });
  return names.filter((n): n is string => n != null).join(" / ");
}

function requireLabel(seconds: RequireAfterSeconds): string {
  if (seconds === 0) return t("mobile.appLock.immediately");
  if (seconds === 60) return t("mobile.appLock.afterMinute");
  return t("mobile.appLock.afterMinutes", { n: seconds / 60 });
}

export default function AppLockSettingsScreen() {
  const enabled = useAppLock((s) => s.enabled);
  const requireAfterSeconds = useAppLock((s) => s.requireAfterSeconds);
  const setEnabled = useAppLock((s) => s.setEnabled);
  const setRequireAfterSeconds = useAppLock((s) => s.setRequireAfterSeconds);
  const lock = useAppLock((s) => s.lock);

  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  const caps = useQuery({
    queryKey: ["app-lock", "capabilities"],
    queryFn: probe,
    staleTime: 0,
  });

  // Enrolment changes in the OS Settings app, not here: the user leaves,
  // registers a finger, comes back. Re-probe on every return to foreground.
  const refetchCaps = caps.refetch;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refetchCaps();
    });
    return () => sub.remove();
  }, [refetchCaps]);

  const toggle = async (next: boolean) => {
    if (!next) {
      setEnabled(false);
      setNotice({ tone: "ok", text: t("mobile.appLock.disabledNotice") });
      return;
    }
    if (verifying) return;
    setVerifying(true);
    setNotice(null);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t("mobile.appLock.prompt"),
        cancelLabel: t("app.common.cancel"),
        fallbackLabel: t("mobile.appLock.usePasscode"),
        disableDeviceFallback: false,
      });
      if (result.success) {
        setEnabled(true);
        setNotice({ tone: "ok", text: t("mobile.appLock.enabledNotice") });
      } else if (
        result.error === "user_cancel" ||
        result.error === "system_cancel" ||
        result.error === "app_cancel"
      ) {
        setNotice({ tone: "err", text: t("mobile.appLock.verifyFirst") });
      } else if (
        result.error === "not_enrolled" ||
        result.error === "passcode_not_set"
      ) {
        setNotice({ tone: "err", text: t("mobile.appLock.err.notEnrolled") });
      } else if (result.error === "not_available") {
        setNotice({ tone: "err", text: t("mobile.appLock.err.notAvailable") });
      } else if (result.error === "lockout") {
        setNotice({ tone: "err", text: t("mobile.appLock.err.lockout") });
      } else {
        setNotice({ tone: "err", text: t("mobile.appLock.err.failed") });
      }
    } catch {
      setNotice({ tone: "err", text: t("mobile.appLock.err.unknown") });
    } finally {
      setVerifying(false);
    }
  };

  const c = caps.data;
  const noPasscode = c != null && c.level === SecurityLevel.NONE;
  const biometricsReady = c != null && c.hasHardware && c.enrolled;

  return (
    <Screen onRefresh={() => void caps.refetch()} refreshing={caps.isRefetching}>
      <SettingsHeader
        parentLabel={t("app.settingsPage.title")}
        title={t("mobile.appLock.title")}
        subtitle={t("mobile.appLock.intro")}
        fallback="/settings"
      />

      {notice ? (
        <Text style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}>
          {notice.text}
        </Text>
      ) : null}

      {/* التفعيل */}
      <Card>
        <ToggleRow
          testID="app-lock-toggle"
          label={t("mobile.appLock.enable")}
          hint={t("mobile.appLock.enableHint")}
          value={enabled}
          onValueChange={(v) => void toggle(v)}
          busy={verifying}
        />
        {enabled ? (
          <Button
            label={t("mobile.appLock.lockNow")}
            variant="outline"
            onPress={lock}
            style={styles.lockNow}
          />
        ) : null}
      </Card>

      {/* اطلب التحقق بعد */}
      <Card title={t("mobile.appLock.requireTitle")}>
        <Text style={styles.sectionHint}>{t("mobile.appLock.requireHint")}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsWrap} contentContainerStyle={styles.chips}>
          {REQUIRE_AFTER_OPTIONS.map((seconds) => (
            <Chip
              key={seconds}
              label={requireLabel(seconds)}
              active={requireAfterSeconds === seconds}
              onPress={() => setRequireAfterSeconds(seconds)}
            />
          ))}
        </ScrollView>
      </Card>

      {/* الجهاز ده */}
      <Card title={t("mobile.appLock.deviceTitle")}>
        {caps.isPending ? (
          <View style={styles.statusRow}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.sectionHint}>{t("mobile.appLock.checking")}</Text>
          </View>
        ) : caps.isError || !c ? (
          <View style={styles.statusRow}>
            <WarningCircle size={20} color={colors.warningStrong} />
            <Text style={styles.statusText}>{t("mobile.appLock.checkFailed")}</Text>
          </View>
        ) : (
          <View style={styles.deviceStack}>
            <View style={styles.kv}>
              <Text style={styles.kvLabel}>{t("mobile.appLock.methodLabel")}</Text>
              <Text style={styles.kvValue}>{methodLabel(c.hasHardware ? c.types : [])}</Text>
            </View>

            {c.hasHardware ? (
              <View style={styles.statusRow}>
                {c.enrolled ? (
                  <CheckCircle size={20} color={colors.success} />
                ) : (
                  <WarningCircle size={20} color={colors.warningStrong} />
                )}
                <Text style={styles.statusText}>
                  {c.enrolled ? t("mobile.appLock.enrolled") : t("mobile.appLock.notEnrolled")}
                </Text>
              </View>
            ) : null}

            {!biometricsReady && !noPasscode ? (
              <View style={styles.statusRow}>
                <LockKey size={20} color={colors.textSecondary} />
                <Text style={styles.sectionHint}>
                  {c.hasHardware
                    ? t("mobile.appLock.notEnrolledHint")
                    : t("mobile.appLock.passcodeOnly")}
                </Text>
              </View>
            ) : null}

            {noPasscode ? (
              <Text style={styles.warning}>{t("mobile.appLock.noPasscode")}</Text>
            ) : null}
          </View>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  notice: {
    fontFamily: fonts.medium,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
    ...RTL_TEXT,
  },
  noticeOk: { backgroundColor: colors.successLight, color: colors.successStrong },
  noticeErr: { backgroundColor: colors.dangerLight, color: colors.danger },

  lockNow: { marginTop: spacing.lg, minHeight: MIN_TOUCH },

  sectionHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
    flexShrink: 1,
    ...RTL_TEXT,
  },

  // One scrolling row: the three chips overflowed the card by ~5pt and wrapped
  // 2 + 1 with the selected option orphaned on its own line.
  chipsWrap: { marginTop: spacing.md, marginHorizontal: -spacing.lg },
  chips: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },

  deviceStack: { gap: spacing.md },
  kv: { gap: 2 },
  kvLabel: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  kvValue: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  // Same StatusRow look as printers' BleStateRow: 20pt regular icon carrying the tone, 14pt neutral text.
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: MIN_TOUCH },
  statusText: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.text, flex: 1, ...RTL_TEXT },
  warning: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.warningStrong,
    backgroundColor: colors.warningLight,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    lineHeight: 20,
    overflow: "hidden",
    ...RTL_TEXT,
  },
});
