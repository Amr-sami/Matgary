import type { TextStyle, ViewStyle } from "react-native";

/**
 * RTL without I18nManager.
 *
 * `app.config.ts` asks the expo-localization plugin for `forcesRTL`, which is
 * the right mechanism for a real build — it lands in the native config before
 * the JS bundle runs. But config plugins only apply at prebuild, and **Expo Go
 * never runs your prebuild**, so there it is inert. `I18nManager.forceRTL()` is
 * not a fallback either: Expo Go resets the flag on every load, so it never
 * survives the relaunch it needs. Measured, not assumed — the app came back LTR
 * twice.
 *
 * Yoga's `direction` style is the way through. It sets layout direction for a
 * subtree, takes effect on the next render with no relaunch, and behaves
 * identically in Expo Go and in a dev client. Applying it at the root makes
 * every `flexDirection: "row"` below it lay out right-to-left, which is what
 * puts stat-card icons on the left and the text on the right, as the design has
 * them.
 *
 * `writingDirection` is the text-level companion. Without it a Latin string in
 * an Arabic screen (`Persol PO3019S`) aligns left, because RN resolves
 * `textAlign: "auto"` from the string's own script rather than the paragraph's.
 * The web renders those right-aligned inside an RTL paragraph, and this matches
 * that.
 */
export const RTL: ViewStyle = { direction: "rtl" };

export const RTL_TEXT: TextStyle = {
  writingDirection: "rtl",
  textAlign: "right",
};
