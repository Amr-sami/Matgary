import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { EyeIcon as Eye } from "phosphor-react-native/src/icons/Eye";
import { EyeSlashIcon as EyeSlash } from "phosphor-react-native/src/icons/EyeSlash";

import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius } from "@/theme/tokens";
import { t, useLocale } from "@/i18n";

interface FieldProps extends Omit<TextInputProps, "style"> {
  label: string;
  /** Renders the show/hide eye and manages secureTextEntry. */
  secure?: boolean;
  /**
   * Force a left-to-right WRITING direction for values that are never Arabic
   * (phones, emails, codes, URLs): a "+" stays first, digits stay one run.
   * Alignment is NOT forced — the value still starts at the form's reading
   * edge (right in Arabic, left in English) so a phone number under an Arabic
   * label does not sit alone on the far side of the box.
   */
  ltr?: boolean;
}

/**
 * Label above a bordered input. Focus is border-colour only — the web uses no
 * ring and no shadow (doc 03 §6), and adding one here would make the two
 * clients visibly different for no reason.
 *
 * TextInput alignment is PHYSICAL and is resolved here at render time from the
 * locale — never inside StyleSheet.create (evaluated once, so a live locale
 * switch would keep the old side). Two facts force this:
 *  - TextInput is a native UITextField/UITextView: unlike <Text>, Fabric gives
 *    it no left<->right swap under the RTL Yoga root, so `...RTL_TEXT`
 *    (textAlign:"left") would pin the value to the physical left in Arabic.
 *  - With textAlign unset, TextKit's *natural* alignment follows the first
 *    strong character — or, for digit-only / empty content, the DEVICE locale
 *    and even the active keyboard language. That is why "0" placeholders and
 *    typed prices hugged the left of Arabic forms while their labels sat right.
 */
// One input height across Field / SearchField / DateField: fixed, not driven
// by the font's line box (16pt type measured 56pt, 15pt type 54pt — the same
// card showed two heights side by side).
const INPUT_HEIGHT = 52;
const INPUT_PADDING_H = 16;
const EYE_ICON = 20;

export function Field({ label, secure = false, ltr = false, ...props }: FieldProps) {
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // Subscribe so a live language switch re-renders the alignment.
  const rtl = useLocale((s) => s.locale) === "ar";
  const multiline = props.multiline === true;

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.box, multiline && styles.boxMultiline, focused && styles.boxFocused]}>
        <TextInput
          {...props}
          secureTextEntry={secure && !revealed}
          onFocus={(e) => {
            setFocused(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            props.onBlur?.(e);
          }}
          placeholderTextColor={colors.textSecondary}
          style={[
            styles.input,
            rtl ? styles.inputRtl : styles.inputLtr,
            ltr && styles.inputForceLtr,
            multiline && styles.inputMultiline,
          ]}
        />
        {secure ? (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            style={styles.eye}
            accessibilityRole="button"
            accessibilityLabel={revealed ? t("mobile.a11y.hidePassword") : t("mobile.a11y.showPassword")}
          >
            {revealed ? (
              <EyeSlash size={EYE_ICON} color={colors.textSecondary} weight="regular" />
            ) : (
              <Eye size={EYE_ICON} color={colors.textSecondary} weight="regular" />
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  label: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: INPUT_HEIGHT,
    paddingHorizontal: INPUT_PADDING_H,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  // iOS ignores numberOfLines on TextInput, so a "3-line" notes field rendered
  // at single-line height with the placeholder centred. Give it real room and
  // start the text at the top.
  boxMultiline: { height: "auto", minHeight: 96, alignItems: "flex-start" },
  boxFocused: { borderColor: colors.accent },
  input: {
    flex: 1,
    // Fill the box so a tap anywhere inside the border focuses the field; the
    // single-line native control centres its text vertically on its own.
    alignSelf: "stretch",
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
    // Without this, Android adds ~6px of invisible padding that makes the
    // field taller than the box promises.
    includeFontPadding: false,
    paddingVertical: 0,
  },
  // Physical alignment picked from the locale at render (see docblock).
  inputRtl: { textAlign: "right" },
  inputLtr: { textAlign: "left" },
  // `ltr` prop: direction only — alignment above still wins.
  inputForceLtr: { writingDirection: "ltr" },
  inputMultiline: { paddingTop: 12, paddingBottom: 12, textAlignVertical: "top" },
  // A real 44pt target instead of an 18pt glyph + hitSlop. The negative
  // marginEnd (-12) pulls the target outward so the 20pt icon's outer edge
  // lands on the 16pt text inset, not 12pt further in.
  eye: {
    width: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    marginEnd: -((MIN_TOUCH - EYE_ICON) / 2),
    alignItems: "center",
    justifyContent: "center",
  },
});
