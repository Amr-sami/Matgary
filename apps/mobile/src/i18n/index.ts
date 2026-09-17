import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import {
  defaultLocale,
  dictionaries,
  interpolate,
  lookup,
  type Locale,
} from "@matgary/i18n";

/**
 * Locale — switchable LIVE, no reload.
 *
 * The first cut reloaded the bundle on switch, the way the web reloads the
 * page. That cannot work in Expo Go: a JS-initiated reload (DevSettings or
 * expo-updates) restarts the RN bridge without Expo Go re-registering its
 * native modules, and the app comes back with "runtime not ready". Measured,
 * three ways.
 *
 * It also turned out to be unnecessary. On the new architecture, Yoga's
 * `direction` on the root drives text alignment too — booting Arabic with NO
 * per-text direction styles produced a pixel-identical layout. So the whole
 * switch is: persist, update the store, let the root re-key. Every t() below
 * re-runs on the remount and reads the new dictionary.
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

interface LocaleState {
  locale: Locale;
  setLocale: (next: Locale) => Promise<void>;
}

export const useLocale = create<LocaleState>((set) => ({
  locale: readLocale(),
  async setLocale(next) {
    current = next;
    set({ locale: next });
    // Persist after the UI has switched; a failed write must not block it.
    try {
      await SecureStore.setItemAsync(KEY, next);
    } catch {
      /* the choice still applies for this session */
    }
  },
}));

/**
 * Module-level mirror of the store, so t() and money() stay plain functions
 * callable from anywhere — including StyleSheet-adjacent code and non-React
 * modules — without a hook. Kept in sync by setLocale; safe because the root
 * remounts every screen on change, so nothing reads a stale value.
 */
let current: Locale = useLocale.getState().locale;

export function getLocale(): Locale {
  return current;
}

export function isRTL(): boolean {
  return current === "ar";
}

/** t("auth.login.title") — dictionary lookup; the path echoes back when missing. */
export function t(path: string, vars?: Record<string, string | number>): string {
  const s = lookup(dictionaries[current], path);
  return vars ? interpolate(s, vars) : s;
}
