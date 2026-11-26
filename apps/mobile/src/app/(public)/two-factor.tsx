import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";

import { DottedGround } from "@/components/DottedGround";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { LanguagePill } from "@/components/ui/LanguagePill";
import { t, useLocale } from "@/i18n";
import { useSession, type TwoFactorError } from "@/stores/session";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * The second step of a sign-in for an account with 2FA on (doc 14 C7 /
 * decision D3-b). login.tsx pushes this the moment the session store holds a
 * `challenge` — the one-shot token POST /api/v1/auth/login answered with
 * instead of a session — and the store's verifyTwoFactor trades it plus the
 * code for the same session a plain sign-in gets.
 *
 * Same frame as forgot-password.tsx (ground, wordmark, heading, one field)
 * minus the demo pill: someone half-way through their own sign-in is not
 * shopping for a trial store.
 *
 * Leaving is always through the store, never a bare router call: every
 * terminal outcome — expiry, the last attempt burnt, "back to sign in", and
 * a success — clears `challenge`, and the effect below is the ONE place that
 * turns "no challenge any more" into a pop. The login screen underneath then
 * shows the reason (session.signInError) in its own error box.
 */
const RECOVERY_RE = /^[0-9a-f]{5}-?[0-9a-f]{5}$/i;

function attemptsLeftLabel(n: number): string {
  if (n === 1) return t("mobile.twoFactor.attemptsLeft_one");
  if (n === 2) return t("mobile.twoFactor.attemptsLeft_two");
  return t("mobile.twoFactor.attemptsLeft_few", { n });
}

function errorLabel(error: TwoFactorError): string {
  if (error.code === "OTHER") return error.message;
  const count = error.attemptsLeft != null && error.attemptsLeft > 0 ? ` ${attemptsLeftLabel(error.attemptsLeft)}` : "";
  return `${t("mobile.twoFactor.invalidCode")}${count}`;
}

export default function TwoFactorScreen() {
  const insets = useSafeAreaInsets();
  const locale = useLocale((s) => s.locale);

  const challenge = useSession((s) => s.challenge);
  const status = useSession((s) => s.status);
  const signingIn = useSession((s) => s.signingIn);
  const error = useSession((s) => s.twoFactorError);
  const verifyTwoFactor = useSession((s) => s.verifyTwoFactor);
  const cancelTwoFactor = useSession((s) => s.cancelTwoFactor);

  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  // The challenge went away and we are not signed in: the store ended this
  // attempt (expired, out of tries, cancelled). On success the public stack
  // unmounts under the root guard and no navigation is wanted from here.
  useEffect(() => {
    if (challenge || status === "signedIn") return;
    if (router.canGoBack()) router.back();
    else router.replace("/login");
  }, [challenge, status]);

  const trimmed = code.trim();
  const canSubmit = useRecovery ? RECOVERY_RE.test(trimmed) : /^\d{6}$/.test(trimmed);

  const submit = () => {
    if (!canSubmit || signingIn) return;
    void verifyTwoFactor(trimmed);
  };

  const toggleMode = () => {
    setUseRecovery((v) => !v);
    setCode("");
  };

  return (
    <View style={styles.root}>
      <DottedGround />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + 32 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.topBar}>
            <LanguagePill />
          </View>

          <View style={styles.brand}>
            <Logo size="md" locale={locale} />
          </View>

          <Text style={styles.heading}>{t("mobile.twoFactor.title")}</Text>
          <Text style={styles.subheading}>
            {t(useRecovery ? "mobile.twoFactor.recoveryHint" : "mobile.twoFactor.hint")}
          </Text>

          <View style={styles.form}>
            <Field
              // Remount on mode switch so the keyboard type actually changes
              // (a live TextInput keeps the keyboard it opened with) and
              // autoFocus fires again for the new field.
              key={useRecovery ? "recovery" : "totp"}
              label={t(useRecovery ? "mobile.twoFactor.recoveryLabel" : "mobile.twoFactor.codeLabel")}
              testID="two-factor-code"
              value={code}
              onChangeText={setCode}
              placeholder={useRecovery ? "ab12c-3d4e5" : "123456"}
              // Digits and hex only: keep the caret at the end in Arabic (see login.tsx).
              ltr
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={useRecovery ? "default" : "number-pad"}
              maxLength={useRecovery ? 11 : 6}
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              returnKeyType="go"
              onSubmitEditing={submit}
            />

            {error ? (
              <View style={styles.errorBox} accessibilityLiveRegion="polite">
                <Text style={styles.errorText} testID="two-factor-error">
                  {errorLabel(error)}
                </Text>
              </View>
            ) : null}

            {/* Button takes no testID; the wrapper is the automation handle. */}
            <View testID="two-factor-submit" collapsable={false}>
              <Button
                label={t("mobile.twoFactor.verify")}
                loading={signingIn}
                disabled={!canSubmit}
                onPress={submit}
              />
            </View>

            <Pressable
              accessibilityRole="button"
              testID="two-factor-recovery-toggle"
              style={styles.link}
              disabled={signingIn}
              onPress={toggleMode}
            >
              <Text style={styles.linkText}>
                {t(useRecovery ? "mobile.twoFactor.useAuthenticator" : "mobile.twoFactor.useRecovery")}
              </Text>
            </Pressable>
          </View>

          <View style={styles.rule} />

          <Pressable
            accessibilityRole="button"
            testID="two-factor-back"
            style={styles.link}
            disabled={signingIn}
            onPress={cancelTwoFactor}
          >
            <Text style={styles.linkText}>{t("mobile.twoFactor.back")}</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  flex: { flex: 1 },
  content: { paddingHorizontal: spacing.xxl, flexGrow: 1 },
  // The pill alone, on the end side, where login.tsx puts it.
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end" },
  // Must match login.tsx/forgot-password.tsx `brand` exactly or the logo jumps on the hop.
  brand: { alignItems: "center", marginTop: spacing.xxl * 1.5, marginBottom: spacing.xxl },
  heading: {
    fontFamily: fonts.bold,
    fontSize: 32,
    color: colors.text,
    textAlign: "center",
  },
  subheading: {
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 26,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: spacing.xs,
  },
  form: { gap: spacing.lg, marginTop: spacing.xxl },
  errorBox: {
    backgroundColor: colors.dangerLight,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.danger,
    textAlign: "center",
  },
  link: { alignItems: "center", minHeight: 44, justifyContent: "center" },
  linkText: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  rule: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xl,
  },
});
