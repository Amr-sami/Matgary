import { useEffect } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import {
  Cairo_400Regular,
  Cairo_500Medium,
  Cairo_600SemiBold,
  Cairo_700Bold,
  useFonts,
} from "@expo-google-fonts/cairo";

import { AppEffects } from "@/effects/AppEffects";
import { AppLockGate } from "@/components/shell/AppLockGate";
import { initSentry, wrapRoot } from "@/observability/sentry";
import { useSession } from "@/stores/session";
import { useLocale } from "@/i18n";
import { directionStyle } from "@/theme/rtl";
import { colors } from "@/theme/tokens";

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

function RootLayout() {
  const [fontsLoaded] = useFonts({
    Cairo_400Regular,
    Cairo_500Medium,
    Cairo_600SemiBold,
    Cairo_700Bold,
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
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
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
