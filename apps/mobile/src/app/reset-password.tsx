import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Globe, Lightning } from "phosphor-react-native";
import { ApiError } from "@matgary/api-client";

import { useLocale, t } from "@/i18n";
import { api } from "@/api/client";
import { useSession } from "@/stores/session";
import { DottedGround } from "@/components/DottedGround";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { RTL } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Native port of apps/web/app/[lang]/(auth)/reset-password/page.tsx.
 *
 * Reachability: today this route is only reachable via the custom scheme
 * `matgary://reset-password?token=…` (scheme from app.config.ts), i.e. in dev
 * or when opened by hand. The reset email
 * (apps/web/app/api/account/password/forgot/route.ts) sends an https
 * `${origin}/${locale}/reset-password?token=…` link, and the app declares no
 * `ios.associatedDomains` / `android.intentFilters` and has no
 * `+native-intent.ts` to strip the `/ar|/en` prefix — so a tap on that email
 * lands on the web. Wiring universal links (AASA + assetlinks.json on the web
 * origin, app.config.ts entries, +native-intent redirect) is app-level work
 * tracked separately. Same frame as forgot-password.tsx: centred block, one
 * heading, a short form.
 *
 * Flow mirrors the web exactly:
 *   1. On mount, GET /api/account/password/reset/validate?token=… so a dead
 *      link is reported BEFORE the user types a password twice. A transport
 *      failure is treated as "valid" — the POST will surface the real error.
 *   2. POST /api/account/password/reset { token, newPassword }. The server's
 *      400/429 bodies carry a human `error` string, shown as-is (as the web
 *      does); anything else lands on the dictionary's generic error.
 *   3. Success card with a "Continue to sign in" button and a 5 s courtesy
 *      auto-redirect to /login.
 *
 * Every string is a t("auth.reset.*") call evaluated at render — nothing is
 * read at module scope, so the live language switch applies on remount.
 */
const AUTO_REDIRECT_MS = 5000;
const MIN_PASSWORD = 8;

type TokenState = "checking" | "valid" | "invalid";

export default function ResetPasswordScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const rawToken = params.token;
  const token = (Array.isArray(rawToken) ? rawToken[0] : rawToken) ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenState, setTokenState] = useState<TokenState>(token ? "checking" : "invalid");

  const canSubmit = password.length >= MIN_PASSWORD && confirm.length > 0;

  const startDemo = useSession((s) => s.startDemo);
  const signingIn = useSession((s) => s.signingIn);
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);

  // Demo pill — the same flow login.tsx runs. startDemo never throws: a
  // failure lands in session.signInError, which login renders in its own box.
  // This screen has no box under the pill, so read it back once and show it
  // here; the value is fresh because startDemo clears it before it starts.
  //
  // Unlike the (public) screens, this route is declared OUTSIDE both
  // Stack.Protected guards in _layout.tsx, so a status flip to "signedIn" does
  // not drop it from the navigator — we have to leave it ourselves, the way
  // service-paused and onboarding enter the app home.
  const [demoError, setDemoError] = useState<string | null>(null);
  const onDemo = async () => {
    setDemoError(null);
    await startDemo();
    const s = useSession.getState();
    if (s.status === "signedIn") {
      router.replace("/");
      return;
    }
    setDemoError(s.signInError);
  };

  const goToLogin = () => router.replace("/login");
  const goToForgot = () => router.replace("/forgot-password");

  // Pre-validate the token so a stale link surfaces immediately.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setTokenState("checking");
    api
      .request<{ valid: boolean }>(
        `/api/account/password/reset/validate?token=${encodeURIComponent(token)}`,
        { method: "GET", auth: false, noBranch: true },
      )
      .then((j) => {
        if (!cancelled) setTokenState(j.valid ? "valid" : "invalid");
      })
      .catch(() => {
        // Network blip → let the user try; the POST reports the real error.
        if (!cancelled) setTokenState("valid");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Courtesy redirect AFTER the success card has rendered; the button is the
  // primary path and is always available.
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => router.replace("/login"), AUTO_REDIRECT_MS);
    return () => clearTimeout(id);
  }, [done]);

  const onSubmit = async () => {
    if (busy) return;
    setError(null);
    if (password.length < MIN_PASSWORD) {
      setError(t("auth.reset.errors.short"));
      return;
    }
    if (password !== confirm) {
      setError(t("auth.reset.errors.mismatch"));
      return;
    }
    setBusy(true);
    try {
      // Public route (the user is not signed in) — no bearer, no branch header.
      await api.request<{ ok: true }>("/api/account/password/reset", {
        method: "POST",
        body: { token, newPassword: password },
        auth: false,
        noBranch: true,
      });
      setDone(true);
    } catch (e) {
      // 400 (bad/expired token, weak password) and 429 (rate-limited) carry a
      // human `error` string from the server — show it, like the web does.
      const serverMessage =
        e instanceof ApiError &&
        e.status !== null &&
        e.status < 500 &&
        e.message &&
        !e.message.startsWith("HTTP ")
          ? e.message
          : null;
      setError(serverMessage ?? t("auth.reset.errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const renderBody = () => {
    if (tokenState === "checking") {
      return (
        <View style={styles.form} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.note}>{t("auth.reset.checkingLink")}</Text>
        </View>
      );
    }

    if (tokenState === "invalid") {
      return (
        <View style={styles.form} accessibilityLiveRegion="polite">
          {/* The web composes `{invalidLinkPrefix} <Link>{invalidLinkAction}</Link>.`
              as one sentence; here the action is the Button below, so the box
              carries a self-contained sentence instead of a dangling prefix. */}
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{t("auth.reset.invalidLink")}</Text>
          </View>
          <Button label={t("auth.reset.invalidLinkAction")} onPress={goToForgot} />
          <Pressable accessibilityRole="button" style={styles.back} onPress={goToLogin}>
            <Text style={styles.backText}>{t("auth.forgot.backToLogin")}</Text>
          </Pressable>
        </View>
      );
    }

    if (done) {
      return (
        <View style={styles.form} accessibilityLiveRegion="polite">
          <Text style={styles.successText}>{t("auth.reset.successMsg")}</Text>
          <Text style={styles.note}>{t("auth.reset.successBody")}</Text>
          <Button label={t("auth.reset.continueToLogin")} onPress={goToLogin} />
          <Text style={styles.redirecting}>{t("auth.reset.redirecting")}</Text>
        </View>
      );
    }

    return (
      <View style={styles.form}>
        <Field
          label={t("auth.reset.newPasswordLabel")}
          value={password}
          onChangeText={setPassword}
          secure
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="newPassword"
          returnKeyType="next"
        />
        <Field
          label={t("auth.reset.confirmLabel")}
          value={confirm}
          onChangeText={setConfirm}
          secure
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={() => void onSubmit()}
        />

        {error ? (
          <View style={styles.errorBox} accessibilityLiveRegion="polite">
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Button
          label={t("auth.reset.submit")}
          loading={signingIn || busy}
          disabled={!canSubmit}
          onPress={() => void onSubmit()}
        />

        <Pressable accessibilityRole="button" style={styles.back} onPress={goToLogin}>
          <Text style={styles.backText}>{t("auth.forgot.backToLogin")}</Text>
        </Pressable>
      </View>
    );
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
            <Pressable
              style={styles.demoPill}
              accessibilityRole="button"
              disabled={signingIn || busy}
              onPress={() => void onDemo()}
            >
              <Lightning size={16} color={colors.onAccent} weight="fill" />
              <Text numberOfLines={1} style={styles.demoPillText}>
                {t(signingIn ? "auth.demo.busy" : "auth.demo.cta")}
              </Text>
            </Pressable>
            <Pressable
              style={styles.langToggle}
              accessibilityRole="button"
              accessibilityLabel={
                locale === "ar" ? t("app.shell.language.english") : t("app.shell.language.arabic")
              }
              onPress={() => void setLocale(locale === "ar" ? "en" : "ar")}
            >
              <Globe size={20} color={colors.textSecondary} />
              <Text style={styles.langText}>{locale === "ar" ? "ع" : "EN"}</Text>
            </Pressable>
          </View>

          {demoError ? (
            <View style={[styles.errorBox, styles.demoError]} accessibilityLiveRegion="polite">
              <Text style={styles.errorText}>{demoError}</Text>
            </View>
          ) : null}

          <View style={styles.centre}>
            <View style={styles.brand}>
              <Logo size="md" />
            </View>

            <Text style={styles.heading}>{t("auth.reset.title")}</Text>
            <Text style={styles.subheading}>{t("auth.reset.subhead")}</Text>

            {renderBody()}
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
  demoPillText: { fontFamily: fonts.bold, fontSize: 14, color: colors.onAccent },
  demoError: { marginTop: spacing.md },
  langToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    flexShrink: 0,
  },
  langText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
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
    fontFamily: fonts.medium,
    fontSize: 16,
    lineHeight: 26,
    color: colors.successStrong,
    textAlign: "center",
  },
  note: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    color: colors.textSecondary,
    textAlign: "center",
  },
  redirecting: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 18,
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
