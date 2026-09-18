import { ActivityIndicator, StyleSheet, Switch, Text, View } from "react-native";

import { useLocale } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, spacing } from "@/theme/tokens";

export interface ToggleRowProps {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  /** Swaps the Switch for a spinner while a check runs (app-lock's biometric verify). */
  busy?: boolean;
  testID?: string;
}

/** iOS UISwitch intrinsic size; RN's Switch renders 51×31 on both platforms here. */
const SWITCH_W = 51;
const SWITCH_H = 31;
const LABEL_FONT = 14;
const LABEL_LINE = 20;
const HINT_LINE = 18;

/**
 * Where Cairo's glyphs actually sit inside a 20pt line.
 *
 * Cairo (hhea, upm 1000): ascender 1303, descender −571, x-height 500. A 14pt
 * line wants 26.2pt, so at lineHeight 20 RN skips its baseline-centring
 * (RCTApplyBaselineOffset bails when lineHeight < font.lineHeight) and TextKit
 * keeps the ascent: the baseline lands 18.2pt below the line top and the
 * optical centre (baseline − ½ x-height) ≈ 14.7pt — 4.7pt below the 10pt
 * line-box centre, which is the offset the screenshots measured. The Switch's
 * centre is put there instead of on the line box. Derived from the font
 * tables, not re-measured on device: if a screenshot still shows a gap, this
 * is the one constant to nudge.
 */
const GLYPH_CENTRE = LABEL_FONT * (1.303 - 0.5 / 2);
const SWITCH_TOP = Math.round((GLYPH_CENTRE - SWITCH_H / 2) * 2) / 2; // −1

/**
 * Label (+ hint) beside a Switch — the one layout for every toggle.
 *
 * The eight hand-rolled versions centred a 44pt row, so the Switch floated
 * against the whole text block and Cairo's low glyphs sat 4–7pt under the
 * knob. Here the row is top-aligned, the Switch is pinned to the FIRST line's
 * optical centre, and the row's height comes from padding, not minHeight, so
 * a two-line hint grows the row without moving the Switch.
 *
 * RN's Switch keeps the LTR knob convention (on = knob right) whatever the
 * Yoga direction, so under Arabic it is mirrored with `scaleX: -1`, chosen
 * from the live locale at render time — never at module scope.
 */
export function ToggleRow({ label, hint, value, onValueChange, disabled, busy, testID }: ToggleRowProps) {
  const rtl = useLocale((s) => s.locale === "ar");
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.text}>
        <Text style={[styles.label, disabled && styles.labelDisabled]}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <View style={styles.switchSlot}>
        {busy ? (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        ) : (
          <Switch
            value={value}
            onValueChange={onValueChange}
            disabled={disabled}
            trackColor={{ true: colors.accent, false: colors.border }}
            accessibilityLabel={label}
            accessibilityHint={hint}
            style={rtl ? styles.mirror : undefined}
            testID={testID ? `${testID}-switch` : undefined}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    paddingVertical: (MIN_TOUCH - SWITCH_H) / 2,
    minHeight: MIN_TOUCH,
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  label: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: LABEL_FONT,
    lineHeight: LABEL_LINE,
    color: colors.text,
  },
  labelDisabled: { color: colors.textSecondary },
  hint: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: HINT_LINE,
    color: colors.textSecondary,
  },
  switchSlot: {
    flexShrink: 0,
    width: SWITCH_W,
    height: SWITCH_H,
    marginTop: SWITCH_TOP,
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: { width: SWITCH_W, height: SWITCH_H },
  /** Constant, locale-independent — safe in a StyleSheet; the CHOICE is made in render. */
  mirror: { transform: [{ scaleX: -1 }] },
});
