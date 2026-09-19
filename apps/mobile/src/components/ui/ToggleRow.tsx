import { ActivityIndicator, Platform, StyleSheet, Switch, Text, View } from "react-native";

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

/**
 * The Switch's frame. RN lays the iOS Switch out at UISwitch's
 * intrinsicContentSize (49 + 2 for borders = 51 × 31) — but iOS 26's glass
 * switch PAINTS 63 × 28, leading-anchored in that frame and vertically
 * centred, so it overhung the content column by 12pt on the trailing side
 * (mirrored under Arabic; measured on the iOS 26.3 notifications shot). The
 * frame is widened to the painted width there; older iOS keeps 51 × 31 and
 * Android keeps its native measure (no explicit frame).
 */
const GLASS_SWITCH = Platform.OS === "ios" && parseInt(String(Platform.Version), 10) >= 26;
const SWITCH_W = GLASS_SWITCH ? 63 : 51;
const SWITCH_H = 31;
const LABEL_FONT = 14;
const LABEL_LINE = 20;
const HINT_LINE = 18;

/**
 * Where the label's glyphs sit inside its 20pt line — MEASURED on device
 * (iOS 26.3, settings/notifications, 2026-09-19): the Cairo glyph box is
 * centred 10pt below the line top on every row, i.e. the line-box centre —
 * RN does baseline-centre the 14/20 label. (The earlier font-table
 * derivation, 14.7, assumed TextKit kept the ascent and pinned every Switch
 * ~5pt below its label.) The Switch's centre is put there. If a screenshot
 * still shows a gap, this is the one constant to nudge.
 */
const GLYPH_CENTRE = LABEL_LINE / 2;
const SWITCH_TOP = Math.round((GLYPH_CENTRE - SWITCH_H / 2) * 2) / 2; // −5.5

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
            // Android: white thumb (Material's default is the theme teal) and a
            // darker OFF track so the switch stays visible on a white card.
            thumbColor={Platform.OS === "android" ? colors.card : undefined}
            trackColor={{ true: colors.accent, false: Platform.OS === "android" ? colors.switchTrackOff : colors.border }}
            accessibilityLabel={label}
            accessibilityHint={hint}
            style={[GLASS_SWITCH ? styles.frame : undefined, rtl ? styles.mirror : undefined]}
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
  /**
   * No fixed width: the slot wraps the Switch's real frame so its trailing
   * edge lands on the content edge (a 51pt slot let the 63pt glass switch spill
   * past it). Height stays SWITCH_H so a frame of another height (Android's
   * native measure) is still centred on the same line.
   */
  switchSlot: {
    flexShrink: 0,
    height: SWITCH_H,
    marginTop: SWITCH_TOP,
    justifyContent: "center",
  },
  /** iOS 26 only — see SWITCH_W. Constant per platform, never per locale. */
  frame: { width: SWITCH_W, height: SWITCH_H },
  spinner: { width: SWITCH_W, height: SWITCH_H },
  /** Constant, locale-independent — safe in a StyleSheet; the CHOICE is made in render. */
  mirror: { transform: [{ scaleX: -1 }] },
});
