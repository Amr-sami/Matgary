import { type PropsWithChildren, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  AppState,
  type AppStateStatus,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as LocalAuthentication from "expo-local-authentication";
import { SecurityLevel, type LocalAuthenticationError } from "expo-local-authentication";
import { LockKeyIcon as LockKey } from "phosphor-react-native/src/icons/LockKey";

import { setActiveBranchId } from "@/api/client";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { useAppLock } from "@/stores/appLock";
import { useSession } from "@/stores/session";
import { getLocale, t } from "@/i18n";
import { directionStyle, RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * The app lock (doc 06 §7.4). Wraps the root <Stack/> and, when the lock is
 * on and armed, paints an opaque lock screen OVER the children — the children
 * stay mounted, so the navigation state, the cart and every in-flight query
 * survive; unlocking just removes the cover.
 *
 * The cover is a full-screen <Modal>, not an absolute View: RN modals live in
 * their own native window above the root hierarchy, so a plain View would sit
 * UNDER any sheet (branch switcher, scanner, returns…) that was open when the
 * app went to the background. A Modal mounted on lock stacks above all of
 * them, and its no-op `onRequestClose` swallows Android's hardware back so
 * the hidden Stack is not popped from behind the cover.
 *
 * Arming happens on two edges only:
 *  - cold start (the store boots `locked` when `enabled`), and
 *  - background → active after more than `requireAfterSeconds` away.
 *    iOS's `inactive` (notification centre, Face ID sheet, an incoming call)
 *    is deliberately NOT counted — a cashier glancing at a notification must
 *    not have to re-authenticate.
 *
 * It never locks while signed out: a fresh sign-in is proof enough, and the
 * login screen is not something to hide. Network never enters into it — not
 * even for the sign-out escape hatch, which completes locally when the
 * server cannot be reached.
 *
 * "Can't authenticate" fails CLOSED unless a capability probe proves there
 * is nothing to check: only `passcode_not_set` / `not_enrolled` are even
 * candidates, and only when `getEnrolledLevelAsync()` says SecurityLevel.NONE
 * does the screen offer a way through to the lock settings. Android maps a
 * handful of transient errors (sensor busy, activity gone during the
 * credential fallback) to `not_available`, so that code is always retryable,
 * never a bypass.
 */

/** Codes that MAY mean the device has no passcode and no biometrics. */
const BYPASS_CANDIDATES: ReadonlySet<LocalAuthenticationError> = new Set([
  "not_enrolled",
  "passcode_not_set",
]);

/** The user backed out — not a failure worth a red line. */
const CANCELLED: ReadonlySet<LocalAuthenticationError> = new Set([
  "user_cancel",
  "system_cancel",
  "app_cancel",
]);

function errorCopy(error: LocalAuthenticationError, bypassable: boolean): string {
  switch (error) {
    case "not_available":
      return t("mobile.appLock.err.notAvailableRetry");
    case "not_enrolled":
    case "passcode_not_set":
      // Probe said the device IS secured: the code was transient, so ask the
      // user to try again rather than telling them nothing is set up.
      return bypassable
        ? t("mobile.appLock.err.notEnrolled")
        : t("mobile.appLock.err.notAvailableRetry");
    case "lockout":
      return t("mobile.appLock.err.lockout");
    case "authentication_failed":
    case "unable_to_process":
    case "timeout":
    case "user_fallback":
      return t("mobile.appLock.err.failed");
    case "user_cancel":
    case "system_cancel":
    case "app_cancel":
      return t("mobile.appLock.err.cancelled");
    default:
      return t("mobile.appLock.err.unknown");
  }
}

/**
 * True only when the device provably has nothing to authenticate with. Any
 * failure of the probe itself fails closed.
 */
async function deviceHasNoSecurity(): Promise<boolean> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level === SecurityLevel.NONE;
  } catch {
    return false;
  }
}

export function AppLockGate({ children }: PropsWithChildren) {
  const status = useSession((s) => s.status);
  const enabled = useAppLock((s) => s.enabled);
  const locked = useAppLock((s) => s.locked);
  const unlock = useAppLock((s) => s.unlock);
  const onForeground = useAppLock((s) => s.onForeground);

  const visible = status === "signedIn" && enabled && locked;

  // The cover is a Modal, and so is every Sheet. They present from the same
  // root view controller, and UIKit refuses a presentation while another one
  // is still dismissing. Sheets hide the instant `locked` flips (Sheet.tsx),
  // so the cover waits one dismiss-animation (~400 ms) before presenting;
  // hiding is immediate. Children stay covered by `pointerEvents`/a11y flags
  // driven by `visible`, so nothing is interactive during the gap.
  const [coverVisible, setCoverVisible] = useState(visible);
  useEffect(() => {
    if (!visible) {
      setCoverVisible(false);
      return;
    }
    const id = setTimeout(() => setCoverVisible(true), 400);
    return () => clearTimeout(id);
  }, [visible]);

  // Background bookkeeping. `hiddenAt` is when we last left the foreground;
  // `authenticating` suppresses that while a prompt is up, because Android's
  // device-credential fallback is a separate activity that backgrounds us.
  const hiddenAt = useRef<number | null>(null);
  const authenticating = useRef(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      const prev = appState.current;
      appState.current = next;

      if (next === "background") {
        if (!authenticating.current) hiddenAt.current = Date.now();
        return;
      }
      if (next === "active" && prev !== "active") {
        const at = hiddenAt.current;
        hiddenAt.current = null;
        if (at != null && useSession.getState().status === "signedIn") {
          onForeground(Date.now() - at);
        }
      }
    });
    return () => sub.remove();
  }, [onForeground]);

  // A sign-in that just happened is the strongest possible unlock.
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current === "signedOut" && status === "signedIn") unlock();
    prevStatus.current = status;
  }, [status, unlock]);

  // iOS restores a focused TextInput's keyboard on foreground — above the
  // cover, hiding the Unlock button and still typing into the hidden field.
  useEffect(() => {
    if (visible) Keyboard.dismiss();
  }, [visible]);

  return (
    <>
      <View
        style={styles.fill}
        importantForAccessibility={visible ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={visible}
      >
        {children}
      </View>
      <Modal
        visible={coverVisible}
        animationType="none"
        presentationStyle="fullScreen"
        statusBarTranslucent
        hardwareAccelerated
        // Android back while locked: swallowed. The Stack behind the cover
        // must not change (§7.4), and the root must not exit the app.
        onRequestClose={() => {}}
      >
        {visible ? <LockScreen authenticating={authenticating} /> : null}
      </Modal>
    </>
  );
}

function LockScreen({ authenticating }: { authenticating: RefObject<boolean> }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const unlock = useAppLock((s) => s.unlock);
  const signOut = useSession((s) => s.signOut);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LocalAuthenticationError | null>(null);
  // Set only after a probe proved the device has no passcode and no
  // biometrics — the one state in which letting the user through is not a
  // bypass, because there was never anything to check.
  const [bypassable, setBypassable] = useState(false);

  const attempt = useCallback(async () => {
    if (authenticating.current) return;
    authenticating.current = true;
    setBusy(true);
    setError(null);
    setBypassable(false);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t("mobile.appLock.prompt"),
        cancelLabel: t("app.common.cancel"),
        fallbackLabel: t("mobile.appLock.usePasscode"),
        // A cashier with a wet finger must still be able to sell: the device
        // passcode stays available as the fallback (§7.4).
        disableDeviceFallback: false,
      });
      if (result.success) {
        unlock();
        return;
      }
      setError(result.error);
      if (BYPASS_CANDIDATES.has(result.error) && (await deviceHasNoSecurity())) {
        setBypassable(true);
      }
    } catch {
      setError("unknown");
    } finally {
      authenticating.current = false;
      setBusy(false);
    }
  }, [authenticating, unlock]);

  // Prompt once as the cover appears. A beat of delay lets the foreground
  // transition finish — iOS refuses a prompt raised mid-transition.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (AppState.currentState === "active") void attempt();
    }, 250);
    return () => clearTimeout(handle);
  }, [attempt]);

  const showError = error != null && !CANCELLED.has(error);

  const openLockSettings = () => {
    // Probe-proven: the device cannot authenticate at all — nothing to
    // protect against, so let the user through to the one screen that can
    // turn this off.
    if (!bypassable) return;
    unlock();
    router.push("/settings/app-lock");
  };

  const confirmSignOut = () => {
    Alert.alert(
      t("mobile.appLock.signOutConfirmTitle"),
      t("mobile.appLock.signOutConfirmBody"),
      [
        { text: t("app.common.cancel"), style: "cancel" },
        {
          text: t("app.shell.userMenu.signOut"),
          style: "destructive",
          onPress: () => {
            // §7.4: the lock screen is never gated behind the network. The
            // server-side logout can fail offline AFTER the local tokens were
            // already cleared — finish the sign-out locally so the user is
            // not stranded behind the cover with a dead session.
            void signOut().catch(() => {
              setActiveBranchId(null);
              useSession.setState({ status: "signedOut", me: null, signInError: null });
              Alert.alert(
                t("mobile.appLock.signedOutOfflineTitle"),
                t("mobile.appLock.signedOutOfflineBody"),
              );
            });
          },
        },
      ],
    );
  };

  return (
    <View
      style={[
        styles.cover,
        directionStyle(getLocale() === "ar"),
        { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xl },
      ]}
      accessibilityViewIsModal
    >
      <View style={styles.top}>
        <Logo size="lg" />
      </View>

      <View style={styles.body}>
        <View style={styles.badge}>
          <LockKey size={40} color={colors.accent} weight="duotone" />
        </View>
        <Text style={styles.title}>{t("mobile.appLock.locked")}</Text>
        <Text style={styles.hint}>{t("mobile.appLock.lockedHint")}</Text>

        {showError ? (
          <Text style={[styles.error, bypassable && styles.errorNeutral]}>
            {errorCopy(error, bypassable)}
          </Text>
        ) : null}

        <Button
          label={showError ? t("app.common.retry") : t("mobile.appLock.unlock")}
          onPress={() => void attempt()}
          loading={busy}
          style={styles.unlock}
        />

        {bypassable ? (
          <Button
            label={t("mobile.appLock.openLockSettings")}
            variant="outline"
            onPress={openLockSettings}
            style={styles.unlock}
          />
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={confirmSignOut}
        hitSlop={12}
        style={({ pressed }) => [styles.signOut, pressed && styles.signOutPressed]}
      >
        <Text style={styles.signOutLabel}>{t("app.shell.userMenu.signOut")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cover: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xxl,
    justifyContent: "space-between",
    alignItems: "center",
  },
  top: { alignItems: "center" },
  body: { alignItems: "center", gap: spacing.md, alignSelf: "stretch" },
  badge: {
    width: 88,
    height: 88,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 28,
    color: colors.text,
    textAlign: "center",
  },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: "center",
  },
  error: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.danger,
    backgroundColor: colors.dangerLight,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    textAlign: "center",
    alignSelf: "stretch",
    overflow: "hidden",
  },
  errorNeutral: {
    color: colors.warningStrong,
    backgroundColor: colors.warningLight,
  },
  unlock: { alignSelf: "stretch", minHeight: 56, marginTop: spacing.sm },
  signOut: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.lg,
    justifyContent: "center",
    alignItems: "center",
  },
  signOutPressed: { opacity: 0.6 },
  signOutLabel: {
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.danger,
    ...RTL_TEXT,
  },
});
