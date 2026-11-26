import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { WalletIcon as Wallet } from "phosphor-react-native/src/icons/Wallet";
import type { dashboard as dashboardApi } from "@matgary/api-client";

import { ChevronForward } from "@/components/ui/Chevron";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, MIN_TOUCH, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Digital collections — the home screen's "awaiting confirmation" card
 * (mobile-dev-docs/15-digital-collections/13 §4.12), port of the web
 * <AwaitingCollectionsCardServer>.
 *
 * Visibility is decided by the server: GET /api/v1/dashboard sends
 * `collections` only to the owner or a `view_collections` holder while
 * Collections is on, else null (an old server omits it). The card renders
 * nothing for null / undefined / count 0. The offline dashboard snapshot
 * carries the field, so it shows (with the snapshot's age) offline too.
 */
export function AwaitingCollectionsCard({
  data,
}: {
  data: dashboardApi.AwaitingCollections | null | undefined;
}) {
  const router = useRouter();
  if (!data || !(data.count > 0)) return null;
  const late = data.staleCount > 0;
  return (
    <Pressable
      testID="dashboard-collections-awaiting"
      collapsable={false}
      accessibilityRole="link"
      onPress={() => router.push(late ? "/collections?stale=1" : "/collections")}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <View style={styles.icon}>
        <Wallet size={22} color={colors.accent} />
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>{t("app.dashboard.collections.title")}</Text>
        <View style={styles.meta}>
          <Text style={styles.summary}>
            {t("app.dashboard.collections.summary", { count: data.count, amount: money(data.amount) })}
          </Text>
          {late ? (
            <View style={styles.lateChip}>
              <Text style={styles.lateText}>{t("app.dashboard.collections.stale", { n: data.staleCount })}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.open}>{t("app.dashboard.collections.open")}</Text>
      </View>
      <ChevronForward />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevation.card,
  },
  pressed: { opacity: 0.85 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  meta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  summary: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, fontVariant: ["tabular-nums"], ...RTL_TEXT },
  lateChip: {
    borderRadius: radius.full,
    backgroundColor: colors.warningLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  lateText: { fontFamily: fonts.medium, fontSize: 12, color: colors.warningStrong, ...RTL_TEXT },
  open: { fontFamily: fonts.medium, fontSize: 13, color: colors.accent, ...RTL_TEXT },
});
