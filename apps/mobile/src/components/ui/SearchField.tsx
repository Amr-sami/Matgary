import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { BarcodeIcon as Barcode } from "phosphor-react-native/src/icons/Barcode";
import { MagnifyingGlassIcon as MagnifyingGlass } from "phosphor-react-native/src/icons/MagnifyingGlass";
import { XCircleIcon as XCircle } from "phosphor-react-native/src/icons/XCircle";

import { isRTL, t } from "@/i18n";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * The inventory / POS search box. The barcode glyph is not decoration — on the
 * web it marks that the field accepts a scanner's keyboard-wedge input, and on
 * device it is the tap target that opens the camera ScannerSheet. It is only
 * rendered when the screen hands us `onPressScan`: a supplier or customer
 * search has nothing to scan, and an accent-coloured button that does nothing
 * is worse than no button. Those fields get a passive magnifying glass instead.
 *
 * `onSubmitEditing` is the keyboard-wedge path: a Bluetooth/USB scanner types
 * the code and sends Enter, so the screen treats a submit exactly like a
 * camera scan. `submitBehavior="submit"` keeps focus, so the next scan lands
 * in the same field without the cashier tapping it again.
 *
 * Alignment: TextInput is the one place Fabric does NOT mirror textAlign under
 * an RTL layout (ParagraphShadowNode stamps layoutDirection onto the text
 * attributes; BaseTextInputShadowNode never does), so `left` here is PHYSICAL
 * left and `...RTL_TEXT` would pin Arabic to the wrong edge. The side is picked
 * from the locale on every render — never in StyleSheet.create(), which runs
 * once and would freeze the direction across a live language switch.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  onPressScan,
  onSubmitEditing,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  onPressScan?: () => void;
  onSubmitEditing?: (value: string) => void;
}) {
  const rtl = isRTL();
  return (
    <View style={styles.box}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing ? () => onSubmitEditing(value) : undefined}
        submitBehavior={onSubmitEditing ? "submit" : undefined}
        returnKeyType="search"
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, rtl ? styles.inputRtl : styles.inputLtr]}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {value.length > 0 ? (
        <Pressable
          onPress={() => onChangeText("")}
          hitSlop={12}
          style={styles.slot}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.a11y.clearSearch")}
        >
          <XCircle size={18} color={colors.textSecondary} weight="fill" />
        </Pressable>
      ) : null}
      {onPressScan ? (
        <Pressable
          onPress={onPressScan}
          hitSlop={12}
          style={styles.slot}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.a11y.scanBarcode")}
        >
          <Barcode size={22} color={colors.accent} />
        </Pressable>
      ) : (
        <View style={styles.slot} accessible={false} importantForAccessibility="no">
          <MagnifyingGlass size={20} color={colors.textSecondary} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
    includeFontPadding: false,
    paddingVertical: 12,
  },
  // Physical, on purpose — see the component doc. Applied per render.
  inputRtl: { textAlign: "right", writingDirection: "rtl" },
  inputLtr: { textAlign: "left", writingDirection: "ltr" },
  /**
   * One 44pt trailing slot per glyph (clear, then scan / glass). The negative
   * end margin swallows the row gap so adjacent slots sit flush, and lets the
   * last slot reach into the box padding so its glyph lands where the plain
   * text would have ended.
   */
  slot: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    marginEnd: -spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
});
