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
import { Globe, Lightning } from "phosphor-react-native";

import { DottedGround } from "@/components/DottedGround";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { LOCALE, setLocaleAndReload, t } from "@/i18n";
import { useSession } from "@/stores/session";
import { RTL } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Native port of public__login.png.
 *
 * Doc 04 calls this "the strongest screen in the product", whose composition
 * sets the tone for the rest of the app: the demo pill and language toggle
 * above, dotted-grid ground, wordmark, large display heading, generous rounded
 * fields, then a solid primary over an outlined secondary with a rule between.
 *
 * Every string is lifted from apps/web/dictionaries/ar.json (`auth.login.*`)
 * rather than retyped, so the two clients cannot drift apart in wording.
 */
/** Module scope, so it survives remounts but not a reload. See the effect below. */
let autoLoginAttempted = false;

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useSession((s) => s.signIn);
  const startDemo = useSession((s) => s.startDemo);
  const signingIn = useSession((s) => s.signingIn);
  const error = useSession((s) => s.signInError);

  const canSubmit = identifier.trim().length >= 3 && password.length > 0;

  // Dev-only credential prefill.
  //
  // Two reasons this exists. First, the daily loop: retyping an Arabic-store
  // login on every reload is friction the team does not need. Second, the
  // simulator cannot be typed into from an automated test without granting the
  // terminal macOS Accessibility permission, so without this there is no way to
  // drive the signed-in screens in CI.
  //
  // Safe by construction: __DEV__ is false in any release build, so the whole
  // block is dead code Metro strips, and the values come from .env, which is
  // gitignored.
  useEffect(() => {
    if (!__DEV__) return;
    const devUser = process.env.EXPO_PUBLIC_DEV_IDENTIFIER;
    const devPass = process.env.EXPO_PUBLIC_DEV_PASSWORD;
    if (!devUser || !devPass) return;

    // Prefill is harmless on every mount — it only fills the fields.
    setIdentifier(devUser);
    setPassword(devPass);

    // Auto-submit is NOT. This screen mounts again the instant a user signs
    // out, so submitting on every mount makes signing out impossible: the
    // session is cleared, the login screen appears, and this effect logs
    // straight back in. Auto-login is a LAUNCH convenience, so it fires at most
    // once per JS runtime. A reload or a fresh launch resets the module and
    // gives it back; an explicit sign-out does not.
    if (process.env.EXPO_PUBLIC_DEV_AUTOLOGIN === "1" && !autoLoginAttempted) {
      autoLoginAttempted = true;
      void signIn(devUser, devPass);
    }
  }, [signIn]);

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
            <Pressable
              style={styles.demoPill}
              accessibilityRole="button"
              disabled={signingIn}
              onPress={() => void startDemo()}
            >
              <Lightning size={16} color="#FFFFFF" weight="fill" />
              <Text numberOfLines={1} style={styles.demoPillText}>
                {t("auth.demo.cta")}
              </Text>
            </Pressable>
            <Pressable
              style={styles.langToggle}
              accessibilityRole="button"
              accessibilityLabel={LOCALE === "ar" ? "English" : "العربية"}
              onPress={() => void setLocaleAndReload(LOCALE === "ar" ? "en" : "ar")}
            >
              <Globe size={20} color={colors.textSecondary} />
              <Text style={styles.langText}>{LOCALE === "ar" ? "ع" : "EN"}</Text>
            </Pressable>
          </View>

          <View style={styles.brand}>
            <Logo size="md" locale={LOCALE} />
          </View>

          <Text style={styles.heading}>{t("auth.login.title")}</Text>
          <Text style={styles.subheading}>{t("auth.login.subhead")}</Text>

          <View style={styles.form}>
            <Field
              label={t("auth.login.identifierLabel")}
              placeholder={t("auth.login.identifierPlaceholder")}
              value={identifier}
              onChangeText={setIdentifier}
              autoCapitalize="none"
              autoCorrect={false}
              // NOT keyboardType="email-address": staff sign in with a
              // synthetic identifier like "cashier@amr-store", which has no
              // TLD, and the email keyboard's autocorrect fights it.
              textContentType="username"
              returnKeyType="next"
            />

            <Field
              label={t("auth.login.passwordLabel")}
              value={password}
              onChangeText={setPassword}
              secure
              autoCapitalize="none"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => {
                if (canSubmit && !signingIn) void signIn(identifier, password);
              }}
            />

            {error ? (
              <View style={styles.errorBox} accessibilityLiveRegion="polite">
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Button
              label={t("auth.login.submit")}
              loading={signingIn}
              disabled={!canSubmit}
              onPress={() => void signIn(identifier, password)}
            />

            <Pressable
              accessibilityRole="button"
              style={styles.forgot}
              onPress={() => router.push("/forgot-password")}
            >
              <Text style={styles.forgotText}>{t("auth.login.forgot")}</Text>
            </Pressable>
          </View>

          <View style={styles.rule} />

          <Text style={styles.noAccount}>{t("auth.login.noAccount")}</Text>
          <Button
            label={t("auth.login.createAccount")}
            variant="outline"
            onPress={() => router.push("/signup")}
          />
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
  forgot: { alignItems: "center", minHeight: 44, justifyContent: "center" },
  forgotText: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  rule: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xl,
  },
  noAccount: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: spacing.lg,
  },
});
