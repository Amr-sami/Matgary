import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Barcode } from "phosphor-react-native";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * The inventory / POS search box. The barcode glyph is not decoration — on the
 * web it marks that the field accepts a scanner's keyboard-wedge input, and on
 * device it becomes the tap target that opens the camera scanner (phase 2).
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  onPressScan,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  onPressScan?: () => void;
}) {
  return (
    <View style={styles.box}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        onPress={onPressScan}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="مسح باركود"
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
});
