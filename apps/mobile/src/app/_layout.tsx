import { useEffect } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Cairo_400Regular,
  Cairo_500Medium,
  Cairo_600SemiBold,
  Cairo_700Bold,
  useFonts,
} from "@expo-google-fonts/cairo";

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
    },
  },
});

export default function RootLayout() {
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
        </Stack>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
