import type { TextStyle, ViewStyle } from "react-native";

/**
 * Layout direction.
 *
 * `RTL` is applied ONCE, by the root layout, from the locale store — Yoga's
 * `direction` propagates to every descendant, and on the new architecture it
 * drives text alignment as well. Booting Arabic with nothing but this on the
 * root produced a layout pixel-identical to one with per-text
 * writingDirection/textAlign on every string. So those are gone.
 *
 * `RTL_TEXT` is kept as an empty style so the ~80 `...RTL_TEXT` spreads across
 * the app keep compiling; it is a no-op and can be removed at leisure. Do not
 * put anything back in it — a per-text direction is exactly what would break
 * a live locale switch, because StyleSheet.create() evaluates once.
 */
export const RTL: ViewStyle = {}; // resolved at runtime — see useDirection()

/**
 * "Start" alignment for every Text. Fabric on iOS only sets a paragraph
 * alignment when textAlign is given; otherwise TextKit's *natural* alignment
 * follows the DEVICE locale (an en-US phone left-aligns Arabic). And under an
 * RTL Yoga layout Fabric swaps left<->right (RCTAttributedTextUtils.mm), so
 * `left` renders at the reading start in both locales: right in Arabic, left
 * in English. Spread this into every text style; use textAlign:"center" or
 * `textAlign:"right"` (= end) only on purpose.
 */
export const RTL_TEXT: TextStyle = { textAlign: "left" };

/** The one place direction is decided. Use on the root, and on Modals (own native root). */
export function directionStyle(rtl: boolean): ViewStyle {
  return { direction: rtl ? "rtl" : "ltr" };
}
