import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Barcode } from "phosphor-react-native";

import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * The inventory / POS search box. The barcode glyph is not decoration — on the
 * web it marks that the field accepts a scanner's keyboard-wedge input, and on
 * device it is the tap target that opens the camera ScannerSheet.
 *
 * `onSubmitEditing` is the keyboard-wedge path: a Bluetooth/USB scanner types
 * the code and sends Enter, so the screen treats a submit exactly like a
 * camera scan. `submitBehavior="submit"` keeps focus, so the next scan lands
 * in the same field without the cashier tapping it again.
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
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        onPress={onPressScan}
        hitSlop={12}
        style={styles.scan}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.a11y.scanBarcode")}
      >
        <Barcode size={22} color={colors.accent} />
      </Pressable>
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
    ...RTL_TEXT,
  },
  scan: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    marginEnd: -spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
});
