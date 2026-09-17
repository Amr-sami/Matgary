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
      backgroundColor: "#FFFFFF",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },

  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-sqlite",
    "expo-sharing",
    "expo-background-task",
    [
      "expo-notifications",
      {
        // Monochrome notification icon (Android) is generated from the mark.
        icon: "./assets/images/icon.png",
        color: "#1203E3",
        defaultChannel: "default",
      },
    ],
    [
      "expo-local-authentication",
      {
        faceIDPermission: "نستخدم بصمة الوجه لفتح التطبيق بسرعة وأمان",
      },
    ],
    [
      "expo-location",
      {
        // Attendance check-in geofence; foreground only.
        locationWhenInUsePermission: "نحتاج موقعك لتسجيل الحضور داخل نطاق المتجر",
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
    [
      "react-native-ble-plx",
      {
        isBackgroundEnabled: false,
        modes: [],
        bluetoothAlwaysPermission: "نحتاج البلوتوث للاتصال بطابعة الفواتير",
      },
    ],
    [
      "@sentry/react-native/expo",
      {
        // Org/project come from EAS secrets at build time; absent locally,
        // the plugin only wires the native SDK and skips source-map upload.
        organization: process.env.SENTRY_ORG ?? "thestoro",
        project: process.env.SENTRY_PROJECT ?? "thestoro-mobile",
      },
    ],
    [
      "expo-camera",
      {
        // iOS NSCameraUsageDescription. Arabic-first, like the display name;
        // the dictionaries carry no permission rationale (app.ui.scanner.* is
        // the web's in-page copy), so this is the one scanner string not
        // routed through t() — it is baked into Info.plist at build time.
        cameraPermission: "نحتاج الكاميرا لمسح باركود المنتجات",
        // No audio: the scanner never records video.
        recordAudioAndroid: false,
      },
    ],
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
        backgroundColor: "#FFFFFF",
        image: "./assets/images/splash-icon.png",
        imageWidth: 120,
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
