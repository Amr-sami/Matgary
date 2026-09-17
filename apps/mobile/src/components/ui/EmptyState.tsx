import { StyleSheet, Text, View } from "react-native";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: spacing.xxl * 1.5, gap: spacing.sm },
  title: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT, textAlign: "center" },
  hint: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, textAlign: "center" },
});
