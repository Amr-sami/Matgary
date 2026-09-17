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

import { ApiError, auth } from "@matgary/api-client";
import { dictionaries } from "@matgary/i18n";

import { getLocale, t, useLocale } from "@/i18n";
import { api, deviceMeta } from "@/api/client";
import { getInstallId } from "@/auth/installId";
import { useSession } from "@/stores/session";
import { DottedGround } from "@/components/DottedGround";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Native port of public__signup.png.
 *
 * Same composition as login.tsx — demo pill and language toggle above, dotted
 * ground, wordmark, display heading, fields, primary button, rule, secondary —
 * with one addition the capture shows: a two-segment step indicator under the
 * subheading. The web is a two-step wizard (account, then store), and the
 * capture is the first step.
 *
 * Every string is lifted from apps/web/dictionaries/ar.json (`auth.signup.*`).
 */
/**
 * The auth.signup subtree, read at render time so the language switch applies.
 * These strings byte-match the web's dictionary; a module-scope copy would
 * have frozen the locale at first load.
 */
const T = () => dictionaries[getLocale()].auth.signup;

/** The exact predicates the web form uses, so the two clients agree on "valid". */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

const isEmail = (v: string) => EMAIL_RE.test(v);
const isHandle = (v: string) => v.length >= 2 && v.length <= 40 && HANDLE_RE.test(v);

/** Suggest a store handle from the email's local part. Ported from the web. */
function suggestHandle(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
  return cleaned.length >= 2 ? cleaned : "";
}

type Availability = "idle" | "checking" | "available" | "taken" | "invalid";

/**
 * Debounced availability probe.
 *
 * Both check routes are in middleware.ts PUBLIC_PATHS, so they answer without a
 * session — which is why these two are wireable natively when the signup
 * submit itself is not. They always return 200 `{ available, reason? }`: a
 * rate-limit deny is deliberately shaped like a syntax failure so the endpoint
 * cannot be used as a presence oracle. Advisory only; the server revalidates.
 */
function useAvailability(
  path: string,
  param: string,
  raw: string,
  valid: (v: string) => boolean,
): Availability {
  const [status, setStatus] = useState<Availability>("idle");

  useEffect(() => {
    const value = raw.trim().toLowerCase();
    if (!value) {
      setStatus("idle");
      return;
    }
    if (!valid(value)) {
      setStatus("invalid");
      return;
    }

    setStatus("checking");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .request<{ available: boolean; reason?: string }>(path, {
          query: { [param]: value },
          auth: false,
          noBranch: true,
          signal: controller.signal,
        })
        .then((json) => {
          setStatus(
            json.reason === "invalid"
              ? "invalid"
              : json.available
                ? "available"
                : "taken",
          );
        })
        .catch(() => {
          // The next keystroke aborted us, or the phone is offline. Neither is
          // worth a message — fall back to "we don't know" and let submit decide.
          setStatus("idle");
        });
    }, 350);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, param, raw, valid]);

  return status;
}

export default function SignupScreen() {
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeHandle, setStoreHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailStatus = useAvailability(
    "/api/account/email/check",
    "email",
    email,
    isEmail,
  );
  const handleStatus = useAvailability(
    "/api/account/store-handle/check",
    "handle",
    storeHandle,
    isHandle,
  );

  useEffect(() => {
    if (!handleEdited) setStoreHandle(suggestHandle(email));
  }, [email, handleEdited]);

  const goToStep2 = () => {
    setError(null);
    if (!isEmail(email.trim().toLowerCase())) {
      setError(T().errors.badEmail);
      return;
    }
    if (emailStatus === "taken") {
      setError(T().emailTaken);
      return;
    }
    if (password.length < 8) {
      setError(T().errors.shortPassword);
      return;
    }
    if (password !== passwordConfirm) {
      setError(T().errors.passwordMismatch);
      return;
    }
    setStep(2);
  };

  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    if (!storeName.trim()) {
      setError(T().errors.storeNameRequired);
      return;
    }
    setSubmitting(true);
    try {
      await auth.signup(api, {
        email: email.trim(),
        password,
        storeName: storeName.trim(),
        storeHandle: storeHandle.trim().toLowerCase(),
        platform: deviceMeta.platform,
        appVersion: deviceMeta.appVersion,
        installId: await getInstallId(),
      });
      // Signup returns the RAW permissions column; the session must be seeded
      // from /me, which is what adoptSession does.
      await useSession.getState().adoptSession();
    } catch (e) {
      setError(signupMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const goToLogin = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/login");
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

          <View style={styles.brand}>
            <Logo size="md" />
          </View>

          <Text style={styles.heading}>{T().title}</Text>
          <Text style={styles.subheading}>
            {step === 1 ? T().step1Sub : T().step2Sub}
          </Text>

          {/* Decorative: the subheading above already says which step this is,
              so the dots are hidden from the screen reader rather than read
              out as two unlabelled views. */}
          <View
            style={styles.steps}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            <View style={[styles.step, step === 1 ? styles.stepOn : styles.stepOff]} />
            <View style={[styles.step, step === 2 ? styles.stepOn : styles.stepOff]} />
          </View>

          {step === 1 ? (
            <View style={styles.form}>
              <View style={styles.fieldGroup}>
                <Field
                  label={T().emailLabel}
                  placeholder={T().emailPlaceholder}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  returnKeyType="next"
                />
                {emailStatus === "available" ? (
                  <Text style={[styles.hint, styles.hintOk]}>{T().emailAvailable}</Text>
                ) : null}
                {emailStatus === "taken" ? (
                  <Text style={[styles.hint, styles.hintBad]}>{T().emailTaken}</Text>
                ) : null}
              </View>

              <Field
                label={T().passwordLabel}
                placeholder={T().passwordPlaceholder}
                value={password}
                onChangeText={setPassword}
                secure
                autoCapitalize="none"
                textContentType="newPassword"
                returnKeyType="next"
              />

              <Field
                label={T().passwordConfirmLabel}
                placeholder={T().passwordConfirmPlaceholder}
                value={passwordConfirm}
                onChangeText={setPasswordConfirm}
                secure
                autoCapitalize="none"
                textContentType="newPassword"
                returnKeyType="go"
                onSubmitEditing={goToStep2}
              />

              {error ? (
                <View style={styles.errorBox} accessibilityLiveRegion="polite">
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              <Button
                label={T().next}
                onPress={goToStep2}
                disabled={
                  emailStatus === "checking" ||
                  emailStatus === "taken" ||
                  emailStatus === "invalid"
                }
              />
            </View>
          ) : (
            <View style={styles.form}>
              <Field
                label={T().storeNameLabel}
                placeholder={T().storeNamePlaceholder}
                value={storeName}
                onChangeText={setStoreName}
                textContentType="organizationName"
                returnKeyType="next"
              />

              <View style={styles.fieldGroup}>
                <Field
                  label={T().handleLabel}
                  placeholder={T().handlePlaceholder}
                  value={storeHandle}
                  onChangeText={(value) => {
                    setStoreHandle(value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                    setHandleEdited(true);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={40}
                  returnKeyType="go"
                  onSubmitEditing={submit}
                />
                <Text style={styles.hint}>
                  {T().handleHint}{" "}
                  <Text style={styles.hintStrong}>
                    ahmed@
                    {handleStatus === "invalid" || !storeHandle
                      ? "yourstore"
                      : storeHandle}
                  </Text>
                </Text>
                {handleStatus === "available" ? (
                  <Text style={[styles.hint, styles.hintOk]}>{T().handleAvailable}</Text>
                ) : null}
                {handleStatus === "taken" ? (
                  <Text style={[styles.hint, styles.hintBad]}>{T().handleTaken}</Text>
                ) : null}
                {handleStatus === "invalid" && storeHandle.length >= 2 ? (
                  <Text style={[styles.hint, styles.hintBad]}>{T().handleInvalid}</Text>
                ) : null}
              </View>

              {error ? (
                <View style={styles.errorBox} accessibilityLiveRegion="polite">
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              <View style={styles.stepButtons}>
                <Button
                  label={T().previous}
                  variant="outline"
                  style={styles.stepButton}
                  onPress={() => {
                    setError(null);
                    setStep(1);
                  }}
                />
                <Button
                  label={T().submit}
                  style={styles.stepButton}
                  onPress={() => void submit()}
                  loading={submitting}
                  disabled={
                    handleStatus === "checking" ||
                    handleStatus === "taken" ||
                    handleStatus === "invalid"
                  }
                />
              </View>
            </View>
          )}

          <View style={styles.rule} />

          <Text style={styles.noAccount}>{T().haveAccountQ}</Text>
          <Button label={T().signIn} variant="outline" onPress={goToLogin} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/** Field codes from lib/auth/create-account.ts, in the shopkeeper's language. */
function signupMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return t("mobile.signup.createFailed");
  switch (e.code) {
    case "EMAIL_TAKEN":
      return t("mobile.signup.emailTaken");
    case "HANDLE_TAKEN":
      return t("mobile.signup.handleTaken");
    case "BAD_EMAIL_FORMAT":
      return t("mobile.signup.badEmail");
    case "WEAK_PASSWORD":
      return t("auth.signup.errors.shortPassword");
    case "HANDLE_INVALID":
      return t("mobile.signup.handleRule");
    case "STORE_NAME_REQUIRED":
      return t("auth.signup.errors.storeNameRequired");
  }
  switch (e.kind) {
    case "offline":
      return t("mobile.common.offline");
    case "rateLimited":
      return t("mobile.signup.tooMany");
    default:
      return t("mobile.signup.createFailed");
  }
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
  // The web's `h-1.5 w-8 rounded-full`, gap-2, mt-3.
  steps: {
    flexDirection: "row",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  step: { height: 6, width: 32, borderRadius: radius.full },
  stepOn: { backgroundColor: colors.accent },
  // The web's `bg-accent/30`. Opacity rather than a new hex, so the inactive
  // segment cannot drift away from the accent token it is derived from.
  stepOff: { backgroundColor: colors.accent, opacity: 0.3 },
  form: { gap: spacing.lg, marginTop: spacing.xxl },
  // A field plus the small status line under it, tight enough that the line
  // reads as belonging to the field rather than to the next one.
  fieldGroup: { gap: spacing.xs },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  hintStrong: { fontFamily: fonts.medium, color: colors.text },
  // #27AE60 is only 2.87:1 on white and fails AA as text — tokens.ts §success.
  hintOk: { color: colors.successStrong },
  hintBad: { color: colors.danger },
  stepButtons: { flexDirection: "row", gap: spacing.sm },
  stepButton: { flex: 1 },
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
