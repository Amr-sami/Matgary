import { useState } from "react";
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
import { dictionaries } from "@matgary/i18n";
import { Globe, Lightning } from "phosphor-react-native";

import { getLocale, useLocale, t } from "@/i18n";
import { api } from "@/api/client";
import { DottedGround } from "@/components/DottedGround";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { RTL } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Native port of public__forgot-password.png.
 *
 * Same frame as login.tsx, with the short form vertically centred the way the
 * capture shows it — the web auth card is centred in the viewport, and with
 * only one field the block sits noticeably lower than it does on login.
 *
 * Strings come from apps/web/dictionaries/ar.json (`auth.forgot.*`).
 */
/**
 * The auth.forgot subtree, read at render time so the language switch applies.
 * These strings byte-match the web's dictionary; a module-scope copy would
 * have frozen the locale at first load.
 */
const T = () => dictionaries[getLocale()].auth.forgot;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordScreen() {
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canSubmit = EMAIL_RE.test(email.trim().toLowerCase());

  const goToLogin = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/login");
  };

  const onSubmit = async () => {
    if (!canSubmit || busy) return;
    const value = email.trim().toLowerCase();
    setError(null);
    setBusy(true);
    try {
      // /api/account/password/forgot is listed in middleware.ts PUBLIC_PATHS,
      // so it answers without a session — no cookie, no CSRF token, no
      // browser. It always replies 200 `{ ok: true }`, even for an unknown
      // address and even when rate-limited, so the response cannot be used to
      // find out which emails are registered. That is why there is no "no such
      // account" branch here: the server refuses to tell us.
      await api.request<{ ok: true }>("/api/account/password/forgot", {
        method: "POST",
        body: { email: value },
        auth: false,
        noBranch: true,
      });
      setSubmittedEmail(value);
      setSubmitted(true);
    } catch {
      // The only failures left are transport ones (offline, timeout) and a 400
      // whose body carries an English zod message. Neither is worth showing
      // raw on an Arabic-first screen, so both land on the dictionary's
      // generic string.
      setError(T().errors.generic);
    } finally {
      setBusy(false);
    }
  };

  // The email is spliced into the success line as its own run so it stays LTR
  // inside an Arabic paragraph — otherwise the address reorders and reads back
  // wrong, which is exactly the thing the user is checking it for.
  const [successBefore, successAfter] = T().successTitleWithEmail.split("{email}");

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
          {/* TODO(phase-4): same as login.tsx — the demo tenant flow and the
              locale PATCH are real features on the web; neither target exists
              natively yet, so these are composed but not wired. */}
          <View style={styles.topBar}>
            <Pressable style={styles.demoPill} accessibilityRole="button">
              <Lightning size={16} color="#FFFFFF" weight="fill" />
              <Text numberOfLines={1} style={styles.demoPillText}>
                {t("auth.demo.cta")}
              </Text>
            </Pressable>
            <Pressable style={styles.langToggle} accessibilityRole="button" onPress={() => void useLocale.getState().setLocale(getLocale() === "ar" ? "en" : "ar")}>
              <Globe size={20} color={colors.textSecondary} />
              <Text style={styles.langText}>{getLocale() === "ar" ? "ع" : "EN"}</Text>
            </Pressable>
          </View>

          <View style={styles.centre}>
            <View style={styles.brand}>
              <Logo size="md" />
            </View>

            <Text style={styles.heading}>{T().title}</Text>
            <Text style={styles.subheading}>{T().subhead}</Text>

            {submitted ? (
              <View style={styles.form} accessibilityLiveRegion="polite">
                <Text style={styles.successText}>
                  {successBefore}
                  <Text style={styles.successEmail}>{submittedEmail}</Text>
                  {successAfter ?? ""}
                </Text>
                <Text style={styles.successNote}>{T().successNote}</Text>
                <Button label={T().backToLogin} variant="outline" onPress={goToLogin} />
              </View>
            ) : (
              <View style={styles.form}>
                <Field
                  label={T().emailLabel}
                  placeholder={T().emailPlaceholder}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  returnKeyType="go"
                  onSubmitEditing={() => void onSubmit()}
                />

                {error ? (
                  <View style={styles.errorBox} accessibilityLiveRegion="polite">
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}

                <Button
                  label={T().submit}
                  loading={busy}
                  disabled={!canSubmit}
                  onPress={() => void onSubmit()}
                />

                <Pressable
                  accessibilityRole="button"
                  style={styles.back}
                  onPress={goToLogin}
                >
                  <Text style={styles.backText}>{T().backToLogin}</Text>
                </Pressable>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  flex: { flex: 1 },
  content: { paddingHorizontal: spacing.xxl, flexGrow: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  demoPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    borderRadius: radius.full,
    flexShrink: 1,
  },
  demoPillText: { fontFamily: fonts.bold, fontSize: 14, color: "#FFFFFF" },
  langToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    flexShrink: 0,
  },
  langText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  // The capture's whole reason for differing from login.tsx: one field is not
  // enough content to fill the fold, and the web centres what there is.
  centre: { flex: 1, justifyContent: "center" },
  brand: { alignItems: "center", marginBottom: spacing.xxl },
  heading: {
    fontFamily: fonts.bold,
    fontSize: 32,
    color: colors.text,
    textAlign: "center",
  },
  subheading: {
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: spacing.xs,
  },
  form: { gap: spacing.lg, marginTop: spacing.xxl },
  successText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 26,
    color: colors.text,
    textAlign: "center",
  },
  successEmail: { fontFamily: fonts.medium, writingDirection: "ltr" },
  successNote: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 22,
    color: colors.textSecondary,
    textAlign: "center",
  },
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
  back: { alignItems: "center", minHeight: 44, justifyContent: "center" },
  backText: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
});
