import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type ViewStyle,
} from "react-native";

import { MIN_TOUCH, colors, fonts, radius } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "outline" | "ghost";
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}

/**
 * The web's hover state has no native equivalent, so `--accent-hover` is
 * repurposed as the PRESSED colour (doc 03 §2).
 *
 * The label is nowrap-equivalent by construction: numberOfLines={1}. The web
 * shipped buttons that broke a two-word Arabic label one word per line, which
 * is the defect this whole polish pass started from — a native button must not
 * reintroduce it.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  style,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        variant === "primary" && styles.primary,
        variant === "outline" && styles.outline,
        variant === "ghost" && styles.ghost,
        pressed && variant === "primary" && styles.primaryPressed,
        pressed && variant !== "primary" && styles.nonPrimaryPressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === "primary" ? "#FFFFFF" : colors.accent}
        />
      ) : (
        <Text
          numberOfLines={1}
          style={[
            styles.label,
            variant === "primary" ? styles.labelOnAccent : styles.labelAccent,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    paddingHorizontal: 20,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  primary: { backgroundColor: colors.accent },
  primaryPressed: { backgroundColor: colors.accentPressed },
  outline: { backgroundColor: colors.bg, borderColor: colors.accent },
  ghost: { backgroundColor: "transparent", minHeight: MIN_TOUCH },
  nonPrimaryPressed: { backgroundColor: colors.accentLight },
  disabled: { opacity: 0.5 },
  label: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 16 },
  labelOnAccent: { color: "#FFFFFF" },
  labelAccent: { color: colors.accent },
});
