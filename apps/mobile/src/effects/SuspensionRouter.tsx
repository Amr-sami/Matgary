import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { usePathname, useRootNavigationState, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ShieldWarningIcon as ShieldWarning } from "phosphor-react-native/src/icons/ShieldWarning";

import type { MeResponse } from "@matgary/api-client";

import { t, useLocale } from "@/i18n";
import { type BlockedCode, useBlocked } from "@/stores/blocked";
import { useSession } from "@/stores/session";
import { directionStyle, RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * The four-code global interceptor (doc 02 §1.1 rows 19/25/26, §2.14).
 *
 * The api client cannot navigate — it is a plain TS module with no React —
 * so it writes the wall it hit into `useBlocked`, and this effect, mounted
 * once by <AppEffects/>, turns that into a route change:
 *
 *   TENANT_SUSPENDED          → /service-paused   (root; signed in or out)
 *   SUBSCRIPTION_REQUIRED     → /billing          (inside the (app) group)
 *   PASSWORD_CHANGE_REQUIRED  → /settings/change-password  (inside (app))
 *   PERMISSION_DENIED         → stays put; a 4-second bottom banner
 *
 * The (app) group is behind `Stack.Protected guard={status === "signedIn"}`,
 * so a wall that arrives while the session is still bootstrapping is held
 * until the status settles; if it settles to signedOut the login screen is
 * already showing the server's message and the event is dropped.
 *
 * Two of the walls also arrive WITHOUT a 4xx. /api/v1/me is the one read the
 * server answers behind PASSWORD_CHANGE_REQUIRED and SUBSCRIPTION_REQUIRED
 * (it has to — otherwise sign-in and cold launch could never seed a session
 * and every new staff account or lapsed tenant would be stranded on login).
 * It says which wall applies in its body, and the second effect below turns
 * that into the same navigation, before the first tab has fired a query.
 */

type RoutedCode = Exclude<BlockedCode, "PERMISSION_DENIED">;

const ROUTE_FOR: Record<RoutedCode, string> = {
  TENANT_SUSPENDED: "/service-paused",
  SUBSCRIPTION_REQUIRED: "/billing",
  PASSWORD_CHANGE_REQUIRED: "/settings/change-password",
};

/** Routes that only exist while signed in. */
const NEEDS_SESSION: Record<RoutedCode, boolean> = {
  TENANT_SUSPENDED: false,
  SUBSCRIPTION_REQUIRED: true,
  PASSWORD_CHANGE_REQUIRED: true,
};

const BANNER_MS = 4_000;
/** A burst of parallel queries all 403-ing produces one navigation, not five. */
const DEDUPE_MS = 1_500;

export function SuspensionRouter() {
  const current = useBlocked((s) => s.current);
  const clear = useBlocked((s) => s.clear);
  const status = useSession((s) => s.status);
  const me = useSession((s) => s.me);
  const raise = useBlocked((s) => s.raise);
  const router = useRouter();
  const pathname = usePathname();
  const navReady = Boolean(useRootNavigationState()?.key);

  const lastRouted = useRef<{ route: string; at: number } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Proactive path: the wall is stated in /me rather than thrown by a request.
  // Funnelled through the same store so dedupe, the nav-ready hold and the
  // pathname check below apply to both sources alike. Re-runs on every /me
  // refresh (refreshMe, switchBranch, re-login after a password change) — a
  // wall that has lifted simply raises nothing.
  useEffect(() => {
    if (status !== "signedIn" || !me) return;
    const code = wallStatedIn(me);
    if (code) raise(code, code);
  }, [me, status, raise]);

  useEffect(() => {
    if (!current) return;

    if (current.code === "PERMISSION_DENIED") {
      setBanner(t("mobile.errors.permissionDenied"));
      clear();
      return;
    }

    const route = ROUTE_FOR[current.code];

    if (NEEDS_SESSION[current.code]) {
      // Hold until bootstrap decides; the guarded group is not mounted yet.
      if (status === "loading") return;
      if (status !== "signedIn") {
        clear();
        return;
      }
    }
    if (!navReady) return;

    const recent = lastRouted.current;
    const duplicate =
      recent !== null && recent.route === route && current.at - recent.at < DEDUPE_MS;

    if (!duplicate && pathname !== route) {
      lastRouted.current = { route, at: current.at };
      try {
        router.replace(route);
      } catch {
        // Navigator not mounted yet — the next wall (there will be one, every
        // request answers the same way) retries.
      }
    }
    clear();
  }, [current, status, navReady, pathname, router, clear]);

  return <PermissionBanner text={banner} onHidden={() => setBanner(null)} />;
}

/**
 * Same order the server gates in (auth-helpers resolveSession): suspension
 * beats the password wall beats the subscription wall — a user behind two of
 * them is sent to the one every other request would 403 on first.
 */
function wallStatedIn(me: MeResponse): RoutedCode | null {
  if (me.tenant.suspended) return "TENANT_SUSPENDED";
  if (me.user.mustChangePassword) return "PASSWORD_CHANGE_REQUIRED";
  if (!me.tenant.subscriptionAccessActive) return "SUBSCRIPTION_REQUIRED";
  return null;
}

// -------------------------------------------------------------------- banner

function PermissionBanner({
  text,
  onHidden,
}: {
  text: string | null;
  onHidden: () => void;
}) {
  const insets = useSafeAreaInsets();
  // Rendered by <AppEffects/>, a sibling of the <Stack/> — so the root's
  // `direction` never reaches it. Same rule as a Modal: set it ourselves.
  const locale = useLocale((s) => s.locale);
  const opacity = useRef(new Animated.Value(0)).current;
  // Keep the last text on screen while it fades out.
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (!text) return;
    setShown(text);
    opacity.stopAnimation();
    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished) {
            setShown(null);
            onHidden();
          }
        },
      );
    }, BANNER_MS);
    return () => clearTimeout(timer);
    // `onHidden` is a fresh closure every render; the timer must not restart on it.
  }, [text, opacity]);

  if (!shown) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.host,
        directionStyle(locale === "ar"),
        { bottom: insets.bottom + BOTTOM_NAV_CLEARANCE },
      ]}
    >
      <Animated.View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[styles.banner, { opacity }]}
      >
        <ShieldWarning size={20} color={colors.warningStrong} weight="fill" />
        <Text style={styles.text} numberOfLines={3}>
          {shown}
        </Text>
      </Animated.View>
    </View>
  );
}

/** Tab bar height (icon + label + padding) so the banner never covers it. */
const BOTTOM_NAV_CLEARANCE = 64 + spacing.md;

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    // Mounted before the <Stack/>; both are needed to paint above it.
    zIndex: 1000,
    elevation: 12,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    maxWidth: 480,
    width: "100%",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.warningLight,
    borderWidth: 1,
    borderColor: colors.warningTint,
    ...elevation.dropdown,
  },
  text: {
    ...RTL_TEXT,
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 20,
    color: colors.warningStrong,
  },
});
