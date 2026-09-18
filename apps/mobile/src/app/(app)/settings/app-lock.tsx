import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as LocalAuthentication from "expo-local-authentication";
import { AuthenticationType, SecurityLevel } from "expo-local-authentication";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { LockKeyIcon as LockKey } from "phosphor-react-native/src/icons/LockKey";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";

import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack } from "@/components/ui/Chevron";
import { Chip } from "@/components/ui/Chip";
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
  const router = useRouter();
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
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.back}
        >
          <ChevronBack size={16} color={colors.textSecondary} />
          <Text style={styles.backLabel}>{t("app.settingsPage.title")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("mobile.appLock.title")}</Text>
        <Text style={styles.subtitle}>{t("mobile.appLock.intro")}</Text>
      </View>

      {notice ? (
        <Text style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}>
          {notice.text}
        </Text>
      ) : null}

      {/* التفعيل */}
      <Card>
        <View style={styles.enableRow}>
          <View style={styles.enableBody}>
            <Text style={styles.sectionTitle}>{t("mobile.appLock.enable")}</Text>
            <Text style={styles.sectionHint}>{t("mobile.appLock.enableHint")}</Text>
          </View>
          {verifying ? (
            <ActivityIndicator color={colors.accent} style={styles.switchSlot} />
          ) : (
            <Switch
              value={enabled}
              onValueChange={(v) => void toggle(v)}
              trackColor={{ true: colors.accent, false: colors.border }}
              accessibilityLabel={t("mobile.appLock.enable")}
              style={styles.switchSlot}
            />
          )}
        </View>
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
        <View style={styles.chips}>
          {REQUIRE_AFTER_OPTIONS.map((seconds) => (
            <Chip
              key={seconds}
              label={requireLabel(seconds)}
              active={requireAfterSeconds === seconds}
              onPress={() => setRequireAfterSeconds(seconds)}
            />
          ))}
        </View>
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
            <WarningCircle size={18} color={colors.warningStrong} />
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
                  <CheckCircle size={18} color={colors.success} weight="fill" />
                ) : (
                  <WarningCircle size={18} color={colors.warningStrong} />
                )}
                <Text style={styles.statusText}>
                  {c.enrolled ? t("mobile.appLock.enrolled") : t("mobile.appLock.notEnrolled")}
                </Text>
              </View>
            ) : null}

            {!biometricsReady && !noPasscode ? (
              <View style={styles.statusRow}>
                <LockKey size={18} color={colors.textSecondary} />
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
  header: { gap: spacing.xs },
  back: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 },
  backLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.textSecondary,
    lineHeight: 22,
    ...RTL_TEXT,
  },

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

  enableRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  enableBody: { flex: 1, minWidth: 0, gap: 4 },
  switchSlot: { flexShrink: 0, minWidth: 51, minHeight: 31 },
  lockNow: { marginTop: spacing.lg, minHeight: MIN_TOUCH },

  sectionTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  sectionHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 20,
    flex: 1,
    ...RTL_TEXT,
  },

  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
  },

  deviceStack: { gap: spacing.md },
  kv: { gap: 2 },
  kvLabel: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  kvValue: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  statusText: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, flex: 1, ...RTL_TEXT },
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
