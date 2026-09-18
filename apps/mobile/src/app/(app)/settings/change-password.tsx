import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
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
        <SettingsHeader
          parentLabel={t("app.settingsPage.title")}
          title={t("app.changePassword.title")}
          fallback="/settings"
        />

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
});
