import type { TextStyle, ViewStyle } from "react-native";

import { IS_RTL } from "@/i18n";

/**
 * Layout direction, derived from the locale read at boot (src/i18n).
 *
 * Yoga's `direction` sets layout direction for a subtree with no relaunch and
 * behaves identically in Expo Go and a dev client — which `I18nManager` does
 * not: Expo Go resets its flag on every load. Applied at the root, it puts
 * stat-card icons on the left and text on the right under Arabic, and flips
 * cleanly under English.
 *
 * `writingDirection` is the text companion: without it a Latin product name in
 * an Arabic row aligns by its own script rather than the paragraph's.
 *
 * These are constants on purpose. Every screen spreads them into a static
 * StyleSheet; switching locale reloads the bundle, so "static" is correct.
 */
export const RTL: ViewStyle = { direction: IS_RTL ? "rtl" : "ltr" };

export const RTL_TEXT: TextStyle = {
  writingDirection: IS_RTL ? "rtl" : "ltr",
  textAlign: IS_RTL ? "right" : "left",
};
