import type { TextStyle, ViewStyle } from "react-native";

/**
 * Layout direction — decided in ONE place, at render time.
 *
 * The root Stack (app/_layout.tsx) and settings/_layout.tsx put
 * `directionStyle(locale === "ar")` on `contentStyle`, and the Stack is
 * re-keyed on the locale, so a live language switch remounts every screen
 * under the new Yoga `direction`. Yoga propagates that direction to every
 * descendant node: rows, absolute `start:`/`end:`, marginStart/End — and the
 * text alignment swap below. Nothing else in the app may read the locale into
 * a StyleSheet: `StyleSheet.create()` evaluates once at import, so a
 * per-text `writingDirection`/`textAlign` picked from the locale at module
 * scope would survive the switch and mis-order punctuation in the other
 * language. Do not use I18nManager (it needs a reload); do not use
 * row-reverse or reversed arrays (Yoga already mirrors rows).
 */
export const RTL: ViewStyle = {}; // kept for old imports; direction lives in directionStyle()

/**
 * "Start" alignment for every Text — spread this into every text style.
 *
 * Why `textAlign: "left"` and not nothing: on iOS Fabric
 * (RCTAttributedTextUtils.mm) a paragraph alignment is only set when
 * textAlign is given. With none, TextKit falls back to NATURAL alignment,
 * which follows the DEVICE language — so on an en-US phone/simulator every
 * Arabic Text that is wider than its glyphs (flex:1 beside a Switch, or the
 * default `alignItems: "stretch"` in a column) sat at the physical LEFT while
 * the row around it laid out RTL. That is the "Arabic but LTR" look
 * (team/[userId].tsx permissions Card, 2026-09-18 12:26 screenshot).
 *
 * Why it is direction-safe: the same file swaps left<->right whenever the
 * Text's Yoga node resolved to RTL (`ParagraphShadowNode::getContent` reads
 * `YGNodeLayoutGetDirection`, i.e. the direction that also placed the Switch
 * at the left). So `left` renders at the reading start in both locales —
 * right in Arabic, left in English — with no locale read at module scope.
 * `textAlign: "right"` therefore means END, and `center` is untouched; use
 * either only on purpose.
 *
 * Limits — the only places the swap does not reach:
 *  - A native root of its own (RN Modal): put `directionStyle(rtl)` on its
 *    content View, from the locale hook, or its texts are LTR.
 *  - TextInput: its textAlign is PHYSICAL (no swap). Pick left/right from the
 *    locale at render time for inputs.
 *  - A Latin run inside Arabic (SKU, phone, URL) that breaks apart: give it
 *    its own <Text style={{ writingDirection: "ltr" }}> — that constant is
 *    locale-independent, so it may live in a StyleSheet.
 */
export const RTL_TEXT: TextStyle = { textAlign: "left" };

/** The one place direction is decided. Use on the root, and on Modals (own native root). */
export function directionStyle(rtl: boolean): ViewStyle {
  return { direction: rtl ? "rtl" : "ltr" };
}
