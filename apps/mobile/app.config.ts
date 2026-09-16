import type { ExpoConfig } from "expo/config";

// Dynamic config. Values that differ per build (EAS project id, API base URL)
// come from the environment so the same source builds dev, preview and prod.
//
// The display name is Arabic because the product is Arabic-first — the web app
// titles itself "ستورو" (apps/web/app/layout.tsx:41). CFBundleLocalizations is
// what lets iOS show that name instead of falling back to the ASCII slug.

const config: ExpoConfig = {
  name: "ستورو",
  slug: "matgary",
  scheme: "matgary",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  icon: "./assets/images/icon.png",

  ios: {
    bundleIdentifier: "com.thestoro.app",
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      CFBundleLocalizations: ["ar", "en"],
      CFBundleDevelopmentRegion: "ar",
    },
  },

  android: {
    package: "com.thestoro.app",
    adaptiveIcon: {
      backgroundColor: "#1203E3",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },

  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-localization",
      {
        // Applied natively at build time. I18nManager.forceRTL() at runtime
        // needs an app reload to take effect, which means the first launch
        // after install renders LTR — unacceptable for an Arabic-first app.
        supportsRTL: true,
        forcesRTL: true,
        supportedLocales: ["ar", "en"],
      },
    ],
    [
      "expo-splash-screen",
      {
        backgroundColor: "#1203E3",
        image: "./assets/images/splash-icon.png",
        imageWidth: 76,
      },
    ],
  ],

  experiments: {
    typedRoutes: false,
    reactCompiler: true,
  },

  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:3001",
  },
};

export default config;
