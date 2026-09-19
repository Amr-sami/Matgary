import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { errorText } from "@/lib/errors";
import { useGoBack } from "@/lib/nav";
import { useSession } from "@/stores/session";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";
import { t } from "@/i18n";

/**
 * Port of app__account-change-password.png (/account/change-password on the
 * web). Same route, same body: POST /api/account/password with
 * `{ currentPassword, newPassword }`; the server answers `{ ok: true }` or
 * `{ error: <human-readable string> }` with 400 (bad current password /
 * validation) or 429 (rate limited).
 *
 * The password WALL (doc 02 §1.1 row 25): when /me says
 * `user.mustChangePassword`, every other request 403s PASSWORD_CHANGE_REQUIRED
 * and <SuspensionRouter/> replaces the route with this screen. While the flag
 * is on the screen is the whole app — BottomNav renders nothing (so no tab
 * can flash the dashboard shell and its 403s), the back link is replaced by
 * the wall's own sentence, and the successful re-login below refreshes /me
 * with the flag off, which brings the bar back and lets `goBack` land.
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
  const err = e as { status?: number | null } | null;
  // The route's 429 body is hardcoded Arabic; the mobile app has a locale
  // switch, so it gets our own copy.
  if (err?.status === 429) return t("app.changePassword.rateLimited");
  // 400 carries the route's own human-readable sentence (bad current
  // password / TeamConflictError — length is validated before the request),
  // which the shared helper shows as-is; a machine code (a 403
  // PASSWORD_CHANGE_REQUIRED from a stale token, PERMISSION_DENIED) is mapped
  // to its sentence instead of printed raw.
  return errorText(e, fallback);
}

/**
 * The three inputs are the shared <Field secure>: 52pt box, 15pt type, the
 * show/hide eye — the same control every other form in the app draws. The
 * web capture has no eye and a slightly taller box; sibling consistency on
 * mobile wins over pixel parity with the browser.
 */
export default function ChangePasswordScreen() {
  const goBack = useGoBack("/settings");
  const insets = useSafeAreaInsets();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const passwordWall = useSession((s) => s.me?.user.mustChangePassword === true);

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
      setTimeout(goBack, 900);
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

  // Own frame instead of <Screen>: the form needs
  // `automaticallyAdjustKeyboardInsets`, which <Screen> does not expose. Same
  // safe-area top (on the ROOT, so the bg is painted behind the clock while
  // the form scrolls under it — see Screen.tsx), side gutter and
  // tab-bar-clearing bottom padding as Screen. Direction is inherited from
  // the root Stack's contentStyle.
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {passwordWall ? (
          // Behind the wall there is nowhere to go back to: the tab bar is
          // hidden and every other screen 403s. The header says why instead.
          <View style={styles.wallHeader} testID="change-password-wall">
            <Text accessibilityRole="header" style={styles.wallTitle}>
              {t("app.changePassword.title")}
            </Text>
            <View style={[styles.message, styles.messageWall]} accessibilityLiveRegion="polite">
              <Text style={[styles.messageText, styles.messageWallText]}>
                {t("mobile.common.passwordChangeRequired")}
              </Text>
            </View>
          </View>
        ) : (
          <SettingsHeader
            parentLabel={t("app.settingsPage.title")}
            title={t("app.changePassword.title")}
            fallback="/settings"
          />
        )}

        <Card style={styles.card}>
          <Field
            secure
            label={t("app.changePassword.current")}
            value={current}
            onChangeText={setCurrent}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            autoComplete="current-password"
          />
          <Field
            secure
            label={t("app.changePassword.new")}
            value={next}
            onChangeText={setNext}
            placeholder={t("app.changePassword.newPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="newPassword"
            autoComplete="new-password"
          />
          <Field
            secure
            label={t("app.changePassword.confirm")}
            value={confirm}
            onChangeText={setConfirm}
            autoCapitalize="none"
            autoCorrect={false}
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
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: {
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl * 2,
  },

  card: { gap: spacing.lg },

  // flex-start shrink-wraps the text so Yoga (not the paragraph's natural
  // alignment) hugs it to the reading edge inside the tinted pill.
  message: {
    alignItems: "flex-start",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  messageError: { backgroundColor: colors.dangerLight },
  messageSuccess: { backgroundColor: colors.successLight },
  messageText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13 },
  messageErrorText: { color: colors.danger },
  messageSuccessText: { color: colors.successStrong },
  // The wall header: SettingsHeader's title without its back link, plus the
  // reason as a warning pill. Same 24pt/bold and bottom margin as the header.
  wallHeader: { gap: spacing.md, marginBottom: spacing.lg },
  wallTitle: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 24, color: colors.text },
  messageWall: { backgroundColor: colors.warningLight },
  messageWallText: { color: colors.warningStrong },
});
