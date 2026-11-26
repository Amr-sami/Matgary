// First import on purpose: evaluating this module stamps the `js-start`
// boot mark, so it must run before anything else app-side (perf.md §5). It
// has no imports of its own, so nothing is evaluated ahead of the stamp.
import { markBoot, observeBootData } from "@/observability/perf";

import { useEffect } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { useFonts } from "expo-font";

import { AppEffects } from "@/effects/AppEffects";
import { AppLockGate } from "@/components/shell/AppLockGate";
import { initSentry, wrapRoot } from "@/observability/sentry";
import { useSession } from "@/stores/session";
import { useLocale } from "@/i18n";
import { directionStyle } from "@/theme/rtl";
import { colors } from "@/theme/tokens";

/**
 * The app-wide error boundary. expo-router wraps this layout's component in
 * `<Try catch={ErrorBoundary}>`, so a render throw anywhere below with no
 * boundary of its own — the (public) group, AppLockGate, service-paused, the
 * Stack itself — renders the bilingual fallback (retry / back to home / Sentry
 * report) instead of unmounting the tree into a blank white screen once the
 * dev red box is dismissed. Layout scope: "back to home" also remounts.
 */
export { LayoutErrorFallback as ErrorBoundary } from "@/observability/sentry";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The app is offline-first by design (phase 3). Blindly retrying a
      // request that failed because the till is in a basement just delays the
      // error the cashier needs to see, so retry is decided per-query by the
      // ApiError kind rather than globally here.
      retry: false,
      staleTime: 30_000,
      // Doc 06 §5.4: a query always TRIES its fetch, signal or not (the
      // client answers instantly with an ApiError of kind "offline"), and a
      // failure keeps the hydrated snapshot as `data` next to the `error` —
      // screens render the last good answer and say how old it is.
      networkMode: "offlineFirst",
    },
  },
});

// TanStack has no idea about connectivity on native unless told: bound to
// NetInfo, `refetchOnReconnect` and paused fetches resume when the signal
// returns. Same definition of "online" as <OfflineDrainer/>.
onlineManager.setEventListener((setOnline) =>
  NetInfo.addEventListener((state) => setOnline(Boolean(state.isConnected) && state.isInternetReachable !== false)),
);

initSentry();
// `dashboard-data` boot phase: the dashboard query's first live answer.
observeBootData(queryClient);

function RootLayout() {
  // The four weights `fonts` in theme/tokens.ts names, required by file. The
  // package barrel exports all eight, and Metro bundles every `require()` it
  // sees — importing the named constants shipped 375 KB of TTFs nothing loads.
  const [fontsLoaded] = useFonts({
    Cairo_400Regular: require("@expo-google-fonts/cairo/400Regular/Cairo_400Regular.ttf"),
    Cairo_500Medium: require("@expo-google-fonts/cairo/500Medium/Cairo_500Medium.ttf"),
    Cairo_600SemiBold: require("@expo-google-fonts/cairo/600SemiBold/Cairo_600SemiBold.ttf"),
    Cairo_700Bold: require("@expo-google-fonts/cairo/700Bold/Cairo_700Bold.ttf"),
  });

  const status = useSession((s) => s.status);
  const bootstrap = useSession((s) => s.bootstrap);
  const locale = useLocale((s) => s.locale);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Hold the splash until BOTH the fonts and the session check are done, so
  // the app never flashes a login screen at a user who is already signed in.
  const ready = fontsLoaded && status !== "loading";

  useEffect(() => {
    if (!ready) return;
    // The frame under the lifting splash is the first one the user sees.
    // Filed immediately (boot.first-screen), not batched behind the dashboard.
    markBoot("first-screen");
    void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider
        // Seeded with the window insets the native side already knows, so the
        // provider renders its children in the SAME commit it mounts in.
        // Without it the provider renders null until the native view reports
        // its insets — the splash lifts (effect above) over an empty frame and
        // the whole tree, tab bar included, pops in a frame later. With the
        // seed, the frame under the splash is the finished first screen.
        //
        // What this does NOT claim to fix: the perf.md §1.4 first-paint slide
        // (content ~one top inset too low for 2–3 frames). §1.4 guessed at a
        // double inset — root `contentStyle` + an `(app)` layout `paddingTop`
        // — but neither layout applies a top inset (the only inset consumers
        // are per-screen: layout/Screen.tsx, (app)/index.tsx). Whether the slide
        // survives this seed is unverified until the §1 screenshot loop is
        // re-run on a device build; do not mark §1.4 closed on this change.
        initialMetrics={initialWindowMetrics}
      >
        <StatusBar style="dark" />
        <AppEffects />
        <AppLockGate>
        <Stack
          // Re-keyed on locale: every screen remounts, so every t() re-reads
          // the dictionary and every layout re-resolves under the new
          // direction. This is the entire language switch — no reload.
          key={locale}
          screenOptions={{
            headerShown: false,
            // Direction is applied here, at the one place every screen passes
            // through. Yoga propagates it to every descendant, text included.
            contentStyle: { backgroundColor: colors.bg, ...directionStyle(locale === "ar") },
          }}
        >
          <Stack.Protected guard={status === "signedIn"}>
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          <Stack.Protected guard={status !== "signedIn"}>
            <Stack.Screen name="(public)" />
          </Stack.Protected>
          {/* Reachable signed in or out: suspended-tenant landing, privacy/terms. */}
          <Stack.Screen name="service-paused" />
          <Stack.Screen name="legal/[doc]" />
          {/* Outside the auth guard: a signed-in user's reset e-mail link must still land here. */}
          <Stack.Screen name="reset-password" />
        </Stack>
        </AppLockGate>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

export default wrapRoot(RootLayout);
