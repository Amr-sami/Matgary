import type { ExpoConfig } from "expo/config";

// Dynamic config. Values that differ per build (EAS project id, API base URL)
// come from the environment so the same source builds dev, preview and prod.
//
// The display name is Arabic because the product is Arabic-first — the web app
// titles itself "ستورو" (apps/web/app/layout.tsx:41). CFBundleLocalizations is
// what lets iOS show that name instead of falling back to the ASCII slug.
//
// Release policy (doc 06 §9, mobile-dev-docs/12-release-runbook.md):
//   - `version` is the marketing version shown in both stores. Bump it by hand.
//   - `ios.buildNumber` / `android.versionCode` are the values a *local* build
//     gets. EAS Build ignores them (eas.json `appVersionSource: "remote"` +
//     `autoIncrement` on the production profile) and keeps its own counter,
//     so two people building the same commit cannot collide.
//   - `runtimeVersion.policy: "fingerprint"` (doc 06 §9.7) hashes the native
//     project — installed native modules, plugin props, permission strings,
//     icons, schemes — so an `eas update` can only reach binaries whose
//     native side is byte-for-byte compatible. A native change therefore
//     never has to be remembered: the fingerprint changes on its own and an
//     old binary is simply not offered the update. Two consequences:
//       * every native change still needs an `eas build` + store release
//         before the next `eas update` can reach anyone;
//       * the fingerprint hashes the *resolved* config, so `eas update` must
//         run with the same EAS_PROJECT_ID / EXPO_PUBLIC_API_URL / SENTRY_*
//         the build worker had (runbook §8) — otherwise the update lands on
//         a runtime no binary has (nothing breaks, nothing arrives).

// EAS project id — written by `eas init`. Absent locally, so the dev client
// never tries to reach the update server and `expo config` still parses.
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || undefined;

// Fail fast on the EAS build worker (EAS sets EAS_BUILD=true on every worker;
// local `expo config` / dev-client builds are unaffected). Without the project
// id a store build would *succeed* with OTA updates disabled and push
// notifications dead (PushRegistrar records `noProjectId`) and nothing would
// flag it until a shop asked where its daily digest went.
if (process.env.EAS_BUILD === "true") {
  if (!EAS_PROJECT_ID) {
    throw new Error(
      "EAS_PROJECT_ID is not set on the EAS build worker — see mobile-dev-docs/12-release-runbook.md §2 (build.base.env)",
    );
  }
  if (
    process.env.EAS_BUILD_PROFILE === "production" &&
    !/^https:\/\//.test(process.env.EXPO_PUBLIC_API_URL ?? "")
  ) {
    throw new Error(
      `EXPO_PUBLIC_API_URL must be an https:// URL for a production build, got ${JSON.stringify(process.env.EXPO_PUBLIC_API_URL)} — see eas.json build.production.env`,
    );
  }
}

const config: ExpoConfig = {
  name: "ستورو",
  slug: "matgary",
  scheme: "matgary",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  icon: "./assets/images/icon.png",

  // OTA updates (doc 06 §9.7). `enabled` and `url` are only set when the EAS
  // project exists; a build without a project id has updates off, which is
  // what a local dev-client build wants anyway.
  runtimeVersion: { policy: "fingerprint" },
  ...(EAS_PROJECT_ID
    ? {
        updates: {
          url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
          enabled: true,
          // Never block a cold start on the network: the shop's connection
          // is the least reliable thing in the room. The update applies on
          // the *next* launch.
          checkAutomatically: "ON_LOAD",
          fallbackToCacheTimeout: 0,
        },
      }
    : {}),

  // Per-locale system strings (doc 06 §9.6 #3). The plugins below bake the
  // ARABIC purpose strings into the base Info.plist / strings.xml (the app is
  // Arabic-first and CFBundleDevelopmentRegion is "ar"); these files give an
  // English-locale device — and most Apple reviewers — English permission
  // prompts and the Latin display name instead. Expo writes
  // `<lang>.lproj/InfoPlist.strings` and `values-b+<lang>/strings.xml` at
  // prebuild. Keep the two files in step with the plugin props below.
  locales: {
    ar: "./locales/ar.json",
    en: "./locales/en.json",
  },

  ios: {
    bundleIdentifier: "com.thestoro.app",
    buildNumber: "1",
    supportsTablet: false,
    // Export compliance (doc 06 §9.4): HTTPS + OS crypto only, which is
    // exempt. Declared twice on purpose — `config.usesNonExemptEncryption` is
    // Expo's typed knob, the infoPlist key is the literal Apple reads — both
    // resolve to the same Info.plist entry, and without it every TestFlight
    // build stalls on the "Missing Compliance" question.
    config: { usesNonExemptEncryption: false },
    // Universal Links + password AutoFill (mobile-dev-docs/10-universal-links.md).
    // The matching AASA is served by apps/web/app/.well-known/… once
    // APPLE_TEAM_ID is set on the server.
    associatedDomains: ["applinks:thestoro.com", "webcredentials:thestoro.com"],
    infoPlist: {
      CFBundleLocalizations: ["ar", "en"],
      CFBundleDevelopmentRegion: "ar",
      ITSAppUsesNonExemptEncryption: false,
    },
    // Privacy manifest (doc 06 §9.6 #8). Expo generates entries for its own
    // modules at prebuild; these cover the non-Expo dependencies that use
    // "required reason" APIs (react-native-mmkv, drizzle/expo-sqlite file
    // handling, TanStack persistence, Sentry) so the upload-time scan never
    // bounces the build. Reason codes are Apple's, one per category:
    //   CA92.1 — UserDefaults, app's own data only
    //   C617.1 — file timestamps, inside the app container only
    //   35F9.1 — system boot time, used for relative timing only
    //   E174.1 — disk space, to decide whether to write a file
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
          NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
        },
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
          NSPrivacyAccessedAPITypeReasons: ["C617.1"],
        },
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
          NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
        },
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
          NSPrivacyAccessedAPITypeReasons: ["E174.1"],
        },
      ],
    },
  },

  android: {
    package: "com.thestoro.app",
    versionCode: 1,
    adaptiveIcon: {
      backgroundColor: "#FFFFFF",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    // App Links (mobile-dev-docs/10-universal-links.md §4). Only the
    // locale-prefixed web paths are listed: the web 307s bare paths to
    // /{locale}/…, and link verification happens before any HTTP request, so
    // a bare entry would never match. `autoVerify` is all-or-nothing per
    // filter — the assetlinks.json must be live (ANDROID_SHA256_CERT_FINGERPRINTS
    // set on the server) or Android silently opens the browser instead.
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          { scheme: "https", host: "thestoro.com", pathPrefix: "/ar/reset-password" },
          { scheme: "https", host: "thestoro.com", pathPrefix: "/en/reset-password" },
          { scheme: "https", host: "thestoro.com", pathPrefix: "/ar/login" },
          { scheme: "https", host: "thestoro.com", pathPrefix: "/en/login" },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },

  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-sqlite",
    "expo-sharing",
    [
      "expo-image-picker",
      {
        photosPermission: "نحتاج الوصول للصور لإضافة صورة الصنف",
        cameraPermission: "نحتاج الكاميرا لتصوير الصنف",
      },
    ],
    "expo-background-task",
    [
      "expo-notifications",
      {
        // Android draws the status-bar / shade icon as an ALPHA MASK, so it must
        // be a transparent PNG with the mark in the opaque pixels. icon.png is
        // opaque RGB and would render as a solid white square on every device;
        // the monochrome adaptive-icon layer already is the transparent mark.
        icon: "./assets/images/android-icon-monochrome.png",
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
        // Android 12+: BLUETOOTH_SCAN with usesPermissionFlags="neverForLocation"
        // (doc 06 §9.6 #10). Without it Play asks why a POS derives location
        // from Bluetooth, and the Data Safety form no longer matches the manifest.
        neverForLocation: true,
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
    eas: { projectId: EAS_PROJECT_ID },
  },
};

export default config;
