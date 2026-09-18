import type { ReactNode } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

/**
 * Every tab screen's frame: safe-area top padding, RTL direction, a title, and
 * pull-to-refresh. Bottom padding clears the tab bar — the bar is absolute over
 * the content, so without it the last row sits under the glyphs.
 *
 * The top inset lives on the ROOT, not inside the scroll content: the
 * ScrollView's frame therefore starts under the status bar and clips scrolled
 * rows there, with the root's background painted behind the clock. Padding
 * the content instead scrolls away with it, and the first row ends up drawn
 * straight through the time/battery glyphs.
 */
export function Screen({
  title,
  subtitle,
  children,
  onRefresh,
  refreshing = false,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          ) : undefined
        }
      >
        {title ? (
          <View style={styles.header}>
            <HeaderAccessories />
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
        ) : null}
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  scroll: { flex: 1 },
  content: {
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl * 2,
    gap: spacing.lg,
  },
  // flex-start shrink-wraps the texts so Yoga (not the paragraph's natural
  // alignment) places them at the reading edge — matters for Latin-only titles
  // like "WhatsApp", which would otherwise hug the left under an RTL layout.
  header: { gap: 4, alignItems: "flex-start" },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
});
