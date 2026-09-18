import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useMutation } from "@tanstack/react-query";
import { KeyIcon as Key } from "phosphor-react-native/src/icons/Key";

import { api } from "@/api/client";
import { ChevronBack } from "@/components/ui/Chevron";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useSession } from "@/stores/session";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { isRTL, t } from "@/i18n";

/**
 * Port of app__account-change-password.png (/account/change-password on the
 * web). Same route, same body: POST /api/account/password with
 * `{ currentPassword, newPassword }`; the server answers `{ ok: true }` or
 * `{ error: <human-readable string> }` with 400 (bad current password /
 * validation) or 429 (rate limited).
 *
 * The web's `mustChangePassword` banner is dropped: the mobile /api/me
 * payload does not carry that flag (only TeamMember does), and the web's
 * forced-redirect flow is a browser middleware concern.
 *
 * Success is NOT just a pop. The route bumps `users.token_version`, so every
 * live session — this one included — is revoked server-side: the access token
 * keeps working until it expires (≤15 min), then the refresh presents a stale
 * `tv`, gets SESSION_REVOKED, and the user is dumped on the login screen at
 * some random later moment. The web re-resolves its session immediately and
 * lands on /login. Here we do better than both: re-authenticate in place with
 * the new password (login mints tokens carrying the new tv), then pop back to
 * Settings. If that re-login cannot complete (offline, TOTP-gated account, …)
 * we sign out deliberately so the user re-logs in on purpose, not mid-task.
 */
const MIN_LENGTH = 8;

function serverError(e: unknown, fallback: string): string {
  const err = e as { code?: string | null; status?: number | null } | null;
  // The route's 429 body is hardcoded Arabic; the mobile app has a locale
  // switch, so it gets our own copy.
  if (err?.status === 429) return t("app.changePassword.rateLimited");
  // The API puts its human-readable text in `error`, which the client maps to
  // `code`. 400 is the only other status the route emits (bad current
  // password / TeamConflictError — length is validated before the request).
  if (err?.code && err.status === 400) return err.code;
  return fallback;
}

/**
 * The capture's password inputs are plain bordered boxes: label hugging the
 * reading edge, placeholder aligned the same way, no show/hide eye. The shared
 * `Field` cannot draw that here — its `ltr` mode pins the text to the physical
 * left, its `secure` mode always renders the eye, and its label leans on
 * natural alignment, which this build resolves to the LEFT even under the
 * root's `direction: rtl`. So the three boxes are drawn locally.
 *
 * Alignment is Yoga's job, not textAlign's: the label is shrink-wrapped in a
 * `flex-start` row, which the inherited direction resolves to the right edge
 * in Arabic and the left in English. (On iOS Fabric, `textAlign: "right"` on a
 * Text under an RTL layout is swapped to the physical left — see
 * RCTAttributedTextUtils.mm — so it is exactly the wrong tool.) The input is
 * a native control with no such swap, so it gets an explicit textAlign
 * resolved from the locale at render time, never inside StyleSheet.create.
 */
function PasswordField({ label, ...props }: { label: string } & Omit<TextInputProps, "style">) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.fieldWrap}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
      </View>
      <TextInput
        {...props}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        placeholderTextColor={colors.textSecondary}
        style={[
          styles.input,
          isRTL() ? styles.inputRtl : styles.inputLtr,
          focused && styles.inputFocused,
        ]}
      />
    </View>
  );
}

export default function ChangePasswordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const save = useMutation({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      api.request<{ ok: boolean }>("/api/account/password", {
        method: "POST",
        body: vars,
      }),
    onSuccess: async (_data, vars) => {
      setError(null);
      setSuccess(true);
      setCurrent("");
      setNext("");
      setConfirm("");

      // The server just revoked this session (token_version bump). Mint fresh
      // tokens with the new password before the old access token runs out.
      // `signIn` never throws: it reports failure through `signInError`.
      // `isPending` stays true until this resolves, so the button keeps its
      // spinner for the duration.
      const session = useSession.getState();
      const identifier = session.me?.user.email;
      if (identifier) await session.signIn(identifier, vars.newPassword);
      if (!identifier || useSession.getState().signInError) {
        // Could not re-establish the session — end it on purpose, now, rather
        // than letting the refresh fail at a random moment later.
        await useSession.getState().signOut();
        return;
      }
      // Let the success line register before the screen pops.
      setTimeout(() => router.back(), 900);
    },
    onError: (e) => {
      setSuccess(false);
      setError(serverError(e, t("app.changePassword.genericError")));
    },
  });

  const submit = () => {
    setError(null);
    setSuccess(false);
    if (next.length < MIN_LENGTH) {
      setError(t("app.changePassword.tooShort"));
      return;
    }
    if (next !== confirm) {
      setError(t("app.changePassword.mismatch"));
      return;
    }
    save.mutate({ currentPassword: current, newPassword: next });
  };

  const canSubmit =
    current.length > 0 && next.length > 0 && confirm.length > 0 && !save.isPending;

  const header = (
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
    </View>
  );

  // Own frame instead of <Screen>: the capture centres the card vertically in
  // the fold, which needs the scroll content to fill the viewport
  // (flexGrow: 1) — <Screen> does not expose its contentContainerStyle. Same
  // safe-area top, side gutter and tab-bar-clearing bottom padding as Screen.
  // Direction is inherited from the root Stack's contentStyle.
  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {header}

        <View style={styles.center}>
          <Card style={styles.card}>
            <View style={styles.iconWrap}>
              <Key size={24} color={colors.accent} weight="bold" />
            </View>
            <Text style={styles.title}>{t("app.changePassword.title")}</Text>

            <View style={styles.form}>
              <PasswordField
                label={t("app.changePassword.current")}
                value={current}
                onChangeText={setCurrent}
                textContentType="password"
                autoComplete="current-password"
              />
              <PasswordField
                label={t("app.changePassword.new")}
                value={next}
                onChangeText={setNext}
                placeholder={t("app.changePassword.newPlaceholder")}
                textContentType="newPassword"
                autoComplete="new-password"
              />
              <PasswordField
                label={t("app.changePassword.confirm")}
                value={confirm}
                onChangeText={setConfirm}
                textContentType="newPassword"
                autoComplete="new-password"
                onSubmitEditing={submit}
                returnKeyType="done"
              />

              {error ? (
                <View style={[styles.message, styles.messageError]}>
                  <Text style={[styles.messageText, styles.messageErrorText]}>{error}</Text>
                </View>
              ) : null}
              {success ? (
                <View style={[styles.message, styles.messageSuccess]}>
                  <Text style={[styles.messageText, styles.messageSuccessText]}>
                    {t("app.changePassword.success")}
                  </Text>
                </View>
              ) : null}

              <Button
                label={t("app.changePassword.submit")}
                onPress={submit}
                disabled={!canSubmit}
                loading={save.isPending}
              />
            </View>
          </Card>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl * 2,
    gap: spacing.lg,
  },

  header: { gap: spacing.xs },
  back: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 },
  backLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },

  // Fills whatever the header leaves, so the card floats mid-fold as in the
  // capture. When the keyboard is up the scroll view's keyboard inset takes
  // over and the focused input scrolls into view.
  center: { flex: 1, justifyContent: "center" },
  card: { padding: spacing.xl, gap: spacing.md },

  iconWrap: {
    alignSelf: "center",
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 26,
    color: colors.text,
    textAlign: "center",
    marginBottom: spacing.md,
  },

  form: { gap: spacing.lg },

  fieldWrap: { gap: 8 },
  // Yoga resolves flex-start against the inherited direction: right edge in
  // Arabic, left edge in English. No textAlign involved.
  labelRow: { alignItems: "flex-start" },
  label: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  input: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.text,
    // Without this, Android adds ~6px of invisible padding that makes the
    // field taller than the 52px the border box promises.
    includeFontPadding: false,
  },
  inputRtl: { textAlign: "right" },
  inputLtr: { textAlign: "left" },
  inputFocused: { borderColor: colors.accent },

  // Same flex-start trick as the labels: the text shrink-wraps and hugs the
  // reading edge inside the tinted pill.
  message: {
    alignItems: "flex-start",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  messageError: { backgroundColor: colors.dangerLight },
  messageSuccess: { backgroundColor: colors.successLight },
  messageText: { fontFamily: fonts.medium, fontSize: 13 },
  messageErrorText: { color: colors.danger },
  messageSuccessText: { color: colors.successStrong },
});
