import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DottedGround } from "@/components/DottedGround";
import { Wordmark } from "@/components/Wordmark";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { useSession } from "@/stores/session";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Native port of public__login.png.
 *
 * Doc 04 calls this "the strongest screen in the product", whose composition
 * should set the tone for the rest of the app: dotted-grid ground, wordmark,
 * large display heading, generous rounded fields, solid primary above an
 * outlined secondary.
 */
export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useSession((s) => s.signIn);
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
  // block is dead code Metro strips; the values come from .env, which is
  // gitignored; and auto-submit is off unless explicitly switched on.
  useEffect(() => {
    if (!__DEV__) return;
    const devUser = process.env.EXPO_PUBLIC_DEV_IDENTIFIER;
    const devPass = process.env.EXPO_PUBLIC_DEV_PASSWORD;
    if (!devUser || !devPass) return;

    setIdentifier(devUser);
    setPassword(devPass);
    if (process.env.EXPO_PUBLIC_DEV_AUTOLOGIN === "1") {
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
            { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brand}>
            <Wordmark size={38} />
          </View>

          <Text style={styles.heading}>تسجيل الدخول</Text>
          <Text style={styles.subheading}>أهلاً بعودتك</Text>

          <View style={styles.form}>
            <Field
              label="البريد أو اسم المستخدم"
              placeholder="you@example.com"
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
              label="كلمة المرور"
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
              label="تسجيل الدخول"
              loading={signingIn}
              disabled={!canSubmit}
              onPress={() => void signIn(identifier, password)}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: spacing.xxl,
    flexGrow: 1,
  },
  brand: { alignItems: "center", marginBottom: spacing.xxl * 1.5 },
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
  form: { gap: spacing.lg, marginTop: spacing.xxl * 1.5 },
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
});
