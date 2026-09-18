import { useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { ProhibitIcon as Prohibit } from "phosphor-react-native/src/icons/Prohibit";

import { ApiError } from "@matgary/api-client";

import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { t } from "@/i18n";
import { useBlocked } from "@/stores/blocked";
import { messageFor, useSession } from "@/stores/session";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

/**
 * Landing place for `403 TENANT_SUSPENDED` (doc 02 §1.1 row 26). Port of
 * apps/web/app/service-paused — a root route outside both guarded groups, so
 * it renders whether the session survived the wall or bootstrap gave up on it.
 *
 * The web reads the suspension reason off the NextAuth session; a bearer
 * session has no such field, so auth-helpers puts the admin's reason on the
 * 403 body as `detail` and the client keeps it as the wall's message. The
 * reason block renders only when that text is a human sentence, never the
 * bare code.
 *
 * Two ways off the screen besides signing out:
 *   - No wall this run (the route was reached by deep link while the tenant
 *     is active): nothing to show, so it redirects to "/" — app home when
 *     signed in, login when not — the same fallback `+native-intent` uses
 *     for a URL the app has no page for.
 *   - "Check again": /me is asked once more. A reactivated tenant goes
 *     straight back in without signing out and in; a still-paused one gets
 *     the wall re-raised (fresh reason included) and stays put.
 */
export default function ServicePausedScreen() {
  const router = useRouter();
  // Screen's scroll content does not stretch, so centring needs a real height.
  const { height } = useWindowDimensions();
  const signOut = useSession((s) => s.signOut);
  const refreshMe = useSession((s) => s.refreshMe);
  const last = useBlocked((s) => s.last);
  const paused = last?.code === "TENANT_SUSPENDED";
  const reason = paused ? serverDetail(last.message) : null;
  const [signingOut, setSigningOut] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  async function handleCheckAgain() {
    setChecking(true);
    setCheckError(null);
    try {
      // Works signed in or out: bootstrap leaves the tokens in the keychain
      // on a 403, so the client still has a session to ask with.
      await refreshMe();
    } catch (error) {
      if (error instanceof ApiError && error.fatalToSession) {
        // The session died underneath us (revoked, reused): the client has
        // already cleared the keychain and flipped status to signedOut, so
        // the login screen is the only honest destination.
        useBlocked.setState({ current: null, last: null });
        router.replace("/");
        return;
      }
      // Still paused: the client re-raised the wall into `useBlocked` (the
      // router sees we are already here and only clears it) and `last` now
      // carries the freshest reason. Offline / server errors read as such.
      setCheckError(messageFor(error));
      return;
    } finally {
      setChecking(false);
    }
    // /me answered: the pause was lifted. Dropping `last` flips `paused`
    // below, and the <Redirect/> takes over — in the same commit that mounts
    // the (app) group when bootstrap had left us signed out.
    useSession.setState({ status: "signedIn", signInError: null });
    useBlocked.setState({ current: null, last: null });
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      // Unconditional, whatever `status` says. When bootstrap hit the wall it
      // already set signedOut but deliberately LEFT the tokens in the keychain
      // (a 403 is not a dead session); skipping the logout here would relaunch
      // straight back onto this screen after the user tapped "Sign out". The
      // logout route needs no session and `auth.logout` clears the keychain in
      // a finally, so it is safe and correct while signed out too.
      await signOut();
    } catch {
      // Offline, or the server refused: the refresh token is already gone
      // from the keychain (logout clears it in a finally), so the session is
      // over either way. Say so, the same way onSessionLost does.
      useSession.setState({ status: "signedOut", me: null });
    } finally {
      // Bootstrap stored the wall's copy as `signInError`; the login screen
      // renders that verbatim, and "service paused" is not what a user who
      // just chose to sign out should read there.
      useSession.setState({ signInError: null });
      // Clear any wall still queued so the login screen does not bounce back
      // here — `last` too, or the next account to sign in on this device
      // would inherit a stale reason if it ever deep-linked to this route.
      useBlocked.setState({ current: null, last: null });
      setSigningOut(false);
      // Leaving the root route explicitly: the (public) group is guarded by
      // status, and a replace lands us on its index (login) once signed out.
      router.replace("/");
    }
  }

  // Reached by link, not by a wall: the tenant is active as far as this run
  // knows, so there is nothing to say and no reason to trap the user here.
  if (!paused) return <Redirect href="/" />;

  return (
    <Screen>
      <View style={[styles.center, { minHeight: height * 0.7 }]}>
        <Card style={styles.card}>
          <View style={styles.iconWrap}>
            <Prohibit size={30} color={colors.danger} weight="bold" />
          </View>
          <Text style={styles.title}>{t("app.servicePaused.title")}</Text>
          <Text style={styles.message}>{t("app.servicePaused.message")}</Text>

          {reason ? (
            <View style={styles.reasonBox}>
              <Text style={styles.reasonLabel}>{t("app.servicePaused.reasonLabel")}</Text>
              <Text style={styles.reasonText}>{reason}</Text>
            </View>
          ) : null}

          <Text style={styles.hint}>{t("app.servicePaused.contactHint")}</Text>

          <View style={styles.footer}>
            <Button
              variant="outline"
              label={t("mobile.servicePaused.retry")}
              onPress={handleCheckAgain}
              loading={checking}
              disabled={checking || signingOut}
              style={styles.action}
            />
            {checkError ? (
              <Text style={styles.checkError} accessibilityLiveRegion="polite">
                {checkError}
              </Text>
            ) : null}
            <Button
              variant="ghost"
              label={t("app.servicePaused.signOut")}
              onPress={handleSignOut}
              loading={signingOut}
              disabled={signingOut || checking}
              style={styles.action}
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}

/**
 * The client stores `detail ?? code` as the message. A bare machine code is
 * not a reason a shopkeeper can act on — only a human sentence gets shown.
 */
function serverDetail(message: string | undefined): string | null {
  if (!message) return null;
  if (/^[A-Z_]+$/.test(message)) return null;
  if (/^HTTP \d{3}$/.test(message)) return null;
  return message;
}

const styles = StyleSheet.create({
  center: {
    justifyContent: "center",
    paddingVertical: spacing.xxl,
  },
  card: {
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.xxl,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.dangerLight,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xs,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 22,
    color: colors.text,
    textAlign: "center",
  },
  message: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 24,
    color: colors.textSecondary,
    textAlign: "center",
  },
  reasonBox: {
    alignSelf: "stretch",
    alignItems: "flex-start",
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.neutralTint,
  },
  reasonLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: colors.textSecondary,
  },
  reasonText: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    color: colors.text,
  },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
    textAlign: "center",
  },
  footer: {
    alignSelf: "stretch",
    alignItems: "stretch",
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  action: {
    alignSelf: "stretch",
  },
  checkError: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 20,
    color: colors.danger,
    textAlign: "center",
  },
});
