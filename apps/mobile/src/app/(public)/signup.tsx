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
const t = {
  title: "إنشاء حساب جديد",
  step1Sub: "ابدأ بإنشاء حسابك",
  step2Sub: "أخبرنا عن متجرك",
  emailLabel: "بريدك الإلكتروني",
  emailPlaceholder: "you@example.com",
  passwordLabel: "كلمة المرور",
  passwordPlaceholder: "8 أحرف على الأقل",
  passwordConfirmLabel: "أعد كتابة كلمة المرور",
  passwordConfirmPlaceholder: "اكتب كلمة المرور مرة أخرى للتأكد",
  next: "التالي",
  previous: "السابق",
  submit: "إنشاء الحساب",
  storeNameLabel: "اسم المتجر",
  storeNamePlaceholder: "متجر السعادة",
  handleLabel: "اسم تسجيل الدخول للمتجر",
  handlePlaceholder: "elhenawystore",
  handleHint: "يستخدمه موظفوك لتسجيل الدخول، مثل",
  handleAvailable: "متاح ✓",
  handleTaken: "هذا الاسم مستخدم بالفعل في متجر آخر — اختر اسماً مختلفاً",
  handleInvalid: "حروف إنجليزية صغيرة وأرقام و - فقط، يبدأ وينتهي بحرف أو رقم",
  haveAccountQ: "لديك حساب بالفعل؟",
  signIn: "تسجيل الدخول",
  emailAvailable: "متاح ✓",
  emailTaken: "هذا البريد مسجّل بالفعل — استخدم تسجيل الدخول",
  errors: {
    badEmail: "أدخل بريداً إلكترونياً صحيحاً",
    shortPassword: "كلمة المرور يجب أن تكون 8 أحرف على الأقل",
    passwordMismatch: "كلمتا المرور غير متطابقتين",
    storeNameRequired: "اسم المتجر مطلوب",
  },
} as const;

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
      setError(t.errors.badEmail);
      return;
    }
    if (emailStatus === "taken") {
      setError(t.emailTaken);
      return;
    }
    if (password.length < 8) {
      setError(t.errors.shortPassword);
      return;
    }
    if (password !== passwordConfirm) {
      setError(t.errors.passwordMismatch);
      return;
    }
    setStep(2);
  };

  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    if (!storeName.trim()) {
      setError(t.errors.storeNameRequired);
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
                تصفح المتجر التجريبي
              </Text>
            </Pressable>
            <Pressable style={styles.langToggle} accessibilityRole="button">
              <Globe size={20} color={colors.textSecondary} />
              <Text style={styles.langText}>ع</Text>
            </Pressable>
          </View>

          <View style={styles.brand}>
            <Logo size="md" />
          </View>

          <Text style={styles.heading}>{t.title}</Text>
          <Text style={styles.subheading}>
            {step === 1 ? t.step1Sub : t.step2Sub}
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
                  label={t.emailLabel}
                  placeholder={t.emailPlaceholder}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  returnKeyType="next"
                />
                {emailStatus === "available" ? (
                  <Text style={[styles.hint, styles.hintOk]}>{t.emailAvailable}</Text>
                ) : null}
                {emailStatus === "taken" ? (
                  <Text style={[styles.hint, styles.hintBad]}>{t.emailTaken}</Text>
                ) : null}
              </View>

              <Field
                label={t.passwordLabel}
                placeholder={t.passwordPlaceholder}
                value={password}
                onChangeText={setPassword}
                secure
                autoCapitalize="none"
                textContentType="newPassword"
                returnKeyType="next"
              />

              <Field
                label={t.passwordConfirmLabel}
                placeholder={t.passwordConfirmPlaceholder}
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
                label={t.next}
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
                label={t.storeNameLabel}
                placeholder={t.storeNamePlaceholder}
                value={storeName}
                onChangeText={setStoreName}
                textContentType="organizationName"
                returnKeyType="next"
              />

              <View style={styles.fieldGroup}>
                <Field
                  label={t.handleLabel}
                  placeholder={t.handlePlaceholder}
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
                  {t.handleHint}{" "}
                  <Text style={styles.hintStrong}>
                    ahmed@
                    {handleStatus === "invalid" || !storeHandle
                      ? "yourstore"
                      : storeHandle}
                  </Text>
                </Text>
                {handleStatus === "available" ? (
                  <Text style={[styles.hint, styles.hintOk]}>{t.handleAvailable}</Text>
                ) : null}
                {handleStatus === "taken" ? (
                  <Text style={[styles.hint, styles.hintBad]}>{t.handleTaken}</Text>
                ) : null}
                {handleStatus === "invalid" && storeHandle.length >= 2 ? (
                  <Text style={[styles.hint, styles.hintBad]}>{t.handleInvalid}</Text>
                ) : null}
              </View>

              {error ? (
                <View style={styles.errorBox} accessibilityLiveRegion="polite">
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              <View style={styles.stepButtons}>
                <Button
                  label={t.previous}
                  variant="outline"
                  style={styles.stepButton}
                  onPress={() => {
                    setError(null);
                    setStep(1);
                  }}
                />
                <Button
                  label={t.submit}
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

          <Text style={styles.noAccount}>{t.haveAccountQ}</Text>
          <Button label={t.signIn} variant="outline" onPress={goToLogin} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/** Field codes from lib/auth/create-account.ts, in the shopkeeper's language. */
function signupMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "تعذّر إنشاء الحساب";
  switch (e.code) {
    case "EMAIL_TAKEN":
      return "هذا البريد مسجّل بالفعل";
    case "HANDLE_TAKEN":
      return "اسم المتجر هذا مستخدم — اختر اسماً آخر";
    case "BAD_EMAIL_FORMAT":
      return "البريد الإلكتروني غير صحيح";
    case "WEAK_PASSWORD":
      return "كلمة المرور يجب أن تكون 8 أحرف على الأقل";
    case "HANDLE_INVALID":
      return "اسم المتجر: حروف إنجليزية صغيرة وأرقام وشرطة فقط";
    case "STORE_NAME_REQUIRED":
      return "اسم المتجر مطلوب";
  }
  switch (e.kind) {
    case "offline":
      return "تعذّر الاتصال بالخادم";
    case "rateLimited":
      return "محاولات كثيرة. حاول بعد قليل";
    default:
      return "تعذّر إنشاء الحساب";
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
