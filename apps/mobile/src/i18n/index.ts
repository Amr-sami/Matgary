import * as SecureStore from "expo-secure-store";
import { I18nManager } from "react-native";
import {
  defaultLocale,
  dictionaries,
  interpolate,
  lookup,
  type Locale,
} from "@matgary/i18n";

/**
 * Locale, resolved ONCE at module load, synchronously.
 *
 * The web switches language with a PATCH and a full page reload. The phone
 * does the same thing for the same reason: layout direction is read by the
 * native layout engine before the first frame, and `RTL` / `RTL_TEXT` are
 * spread into StyleSheet.create() blocks — static by design, so every screen
 * lays out right without threading a hook through two dozen files. Reading
 * the locale synchronously here is what lets those stay static.
 *
 * SecureStore is used only because it already exists in the app and has a
 * sync getter; the locale is not a secret.
 */
const KEY = "mg.locale";

function readLocale(): Locale {
  // Dev-only override so both languages can be screenshotted from CI without
  // driving the toggle. __DEV__ is false in a release build; Metro strips it.
  if (__DEV__) {
    const forced = process.env.EXPO_PUBLIC_DEV_LOCALE;
    if (forced === "en" || forced === "ar") return forced;
  }
  try {
    const v = SecureStore.getItem(KEY);
    return v === "en" ? "en" : defaultLocale;
  } catch {
    return defaultLocale;
  }
}

export const LOCALE: Locale = readLocale();
export const IS_RTL = LOCALE === "ar";

const dict = dictionaries[LOCALE];

/** t("auth.login.title") — dictionary lookup; the path echoes back when missing. */
export function t(path: string, vars?: Record<string, string | number>): string {
  const s = lookup(dict, path);
  return vars ? interpolate(s, vars) : s;
}

/**
 * Persist the new locale and reload the JS bundle so it takes effect.
 * Mirrors the web (PATCH /api/account/locale + window.location.reload()).
 */
export async function setLocaleAndReload(next: Locale): Promise<void> {
  if (next === LOCALE) return;
  await SecureStore.setItemAsync(KEY, next);
  // Also tell the native side, so a dev-client build's I18nManager agrees on
  // the next launch. In Expo Go this is inert (it resets the flag), which is
  // why the app does not depend on it — `direction:` styles carry RTL.
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(next === "ar");
  await reload();
}

async function reload() {
  try {
    const Updates = await import("expo-updates");
    await Updates.reloadAsync();
    return;
  } catch {
    // expo-updates is not available in Expo Go; fall through.
  }
  const { DevSettings } = await import("react-native");
  DevSettings.reload();
}
