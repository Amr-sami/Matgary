import type { ReactNode } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { usePullRefresh } from "@/components/layout/usePullRefresh";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

/**
 * Every tab screen's frame: safe-area top padding, RTL direction, a title, and
 * pull-to-refresh. Bottom padding clears the tab bar — the bar is absolute over
 * the content, so without it the last row sits under the glyphs.
 *
 * `refreshing` is the caller's QUERY signal (`q.isRefetching`), not what the
 * RefreshControl shows: usePullRefresh turns it into a spinner that is up only
 * from the user's pull to the end of that refetch, so a background refetch
 * (a sheet's mutation invalidating queries) never shows — or strands — it.
 *
 * The top inset lives on the ROOT, not inside the scroll content: the
 * ScrollView's frame therefore starts under the status bar and clips scrolled
 * rows there, with the root's background painted behind the clock. Padding
 * the content instead scrolls away with it, and the first row ends up drawn
 * straight through the time/battery glyphs.
 *
 * `header` is a FIXED band between that inset and the scroll region — for a
 * BackLink or SettingsHeader that must stay reachable once the page is
 * scrolled (product history, long settings forms had no back control on
 * screen but the tab bar). It shares the content's horizontal padding and
 * sits above the ScrollView in the column, so scrolled rows clip at its lower
 * edge instead of sliding under it. The tab screens' own `title` header stays
 * inside the scroll on purpose: it is meant to scroll away.
 */
export function Screen({
  title,
  subtitle,
  header,
  children,
  onRefresh,
  refreshing = false,
}: {
  title?: string;
  subtitle?: string;
  /** Fixed above the scroll region — BackLink / SettingsHeader. */
  header?: ReactNode;
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const pull = usePullRefresh(onRefresh, refreshing);
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {header ? <View style={styles.fixedHeader}>{header}</View> : null}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          pull.onRefresh ? (
            <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
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
  // Same side padding as `content`; the content's own paddingTop is the gap
  // to the first row, so a SettingsHeader's marginBottom reads as it does inline.
  fixedHeader: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
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
