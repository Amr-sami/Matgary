import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius } from "@/theme/tokens";
import { t } from "@/i18n";

interface FieldProps extends Omit<TextInputProps, "style"> {
  label: string;
  /** Renders the show/hide eye and manages secureTextEntry. */
  secure?: boolean;
}

/**
 * Label above a bordered input. Focus is border-colour only — the web uses no
 * ring and no shadow (doc 03 §6), and adding one here would make the two
 * clients visibly different for no reason.
 *
 * textAlign is left unset so RN resolves it from the RTL layout direction,
 * which is forced on at build time via the expo-localization plugin. Hardcoding
 * "right" would break the moment an English user switches locale.
 */
export function Field({ label, secure = false, ...props }: FieldProps) {
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.box, focused && styles.boxFocused]}>
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
          style={styles.input}
        />
        {secure ? (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={revealed ? t("mobile.a11y.hidePassword") : t("mobile.a11y.showPassword")}
          >
            <Text style={styles.eye}>{revealed ? "◉" : "◎"}</Text>
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
    minHeight: 52,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  boxFocused: { borderColor: colors.accent },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.text,
    // Without this, Android adds ~6px of invisible padding that makes the
    // field taller than the 52px the border box promises.
    includeFontPadding: false,
    paddingVertical: 12,
  },
  eye: { fontSize: 18, color: colors.textSecondary },
});
