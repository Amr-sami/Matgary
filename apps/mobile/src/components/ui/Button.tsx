import type { ComponentType } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type ViewStyle,
} from "react-native";

import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

type PhosphorIcon = ComponentType<{ size?: number; color?: string }>;

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "outline" | "ghost";
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  /**
   * Leading glyph (a phosphor component, not an element): the button draws it
   * at 16pt in the label's colour, so it follows the variant and the disabled
   * state without the caller repeating the colour logic. It is rendered before
   * the label in a plain row — Yoga mirrors the order under RTL, so the glyph
   * lands on the reading side in both locales.
   */
  icon?: PhosphorIcon;
}

const ICON_SIZE = 16;

/**
 * The web's hover state has no native equivalent, so `--accent-hover` is
 * repurposed as the PRESSED colour (doc 03 §2).
 *
 * The label is nowrap-equivalent by construction: numberOfLines={1}. The web
 * shipped buttons that broke a two-word Arabic label one word per line, which
 * is the defect this whole polish pass started from — a native button must not
 * reintroduce it.
 *
 * Disabled is a real variant, not an opacity fade: a half-transparent accent
 * fill is a lavender pill with white text that still reads as the primary CTA
 * (settings/printers with Bluetooth off). Disabled buttons drop to the neutral
 * tint with secondary-grey text; outline loses its accent border for the card
 * border. `loading` keeps the accent fill so the white spinner stays visible.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  style,
  icon: Icon,
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const showDisabled = disabled && !loading;
  const iconColor = showDisabled
    ? colors.textSecondary
    : variant === "primary"
      ? "#FFFFFF"
      : colors.accent;

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
        loading && styles.loading,
        showDisabled && variant === "primary" && styles.primaryDisabled,
        showDisabled && variant === "outline" && styles.outlineDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === "primary" ? "#FFFFFF" : colors.accent}
        />
      ) : (
        <>
          {Icon ? <Icon size={ICON_SIZE} color={iconColor} /> : null}
          <Text
            numberOfLines={1}
            style={[
              styles.label,
              variant === "primary" ? styles.labelOnAccent : styles.labelAccent,
              showDisabled && styles.labelDisabled,
            ]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    // A row so an optional leading icon sits beside the label; with no icon a
    // single centred child renders exactly as the column did.
    flexDirection: "row",
    gap: spacing.sm,
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
  loading: { opacity: 0.5 },
  primaryDisabled: { backgroundColor: colors.neutralTint },
  outlineDisabled: { backgroundColor: colors.bg, borderColor: colors.border },
  // flexShrink keeps numberOfLines={1} ellipsising inside the row (Yoga's
  // default shrink is 0, which would let a long label overflow the pill).
  label: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 16, flexShrink: 1 },
  labelOnAccent: { color: "#FFFFFF" },
  labelAccent: { color: colors.accent },
  labelDisabled: { color: colors.textSecondary },
});
