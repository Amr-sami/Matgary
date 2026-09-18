import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowCounterClockwise,
  CurrencyDollar,
  Package,
  ShoppingCart,
} from "phosphor-react-native";
import { ApiError, dashboard as dashboardApi } from "@matgary/api-client";

import { api } from "@/api/client";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { money } from "@/lib/format";
import { useSnapshotAge } from "@/offline/hydrate";
import { StockAlerts } from "@/components/dashboard/StockAlerts";
import { StatCard } from "@/components/ui/StatCard";
import { useSession } from "@/stores/session";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of apps/web/app/[lang]/(app)/page.tsx — the dashboard as it actually
 * ships: greeting, a 2×2 KPI grid with the same four metrics, icons and
 * colours, then the stock-alert tile, over the permission-filtered tab bar.
 *
 * The four cards mirror StatsGrid.tsx one-for-one, including which icon and
 * which semantic colour each carries.
 */
export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const me = useSession((s) => s.me);
  const activeBranchId = me?.branch.id ?? null;
  // Same rule as web Greeting.tsx: the owner is greeted by the shop, staff by
  // their own name. `tenant.name` is what the web reads as `settings.shopName`.
  const greetingName =
    (me?.isOwner ? me.tenant.name?.trim() || me.user.name : me?.user.name) ?? "";

  const { data, error, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["dashboard", activeBranchId],
    queryFn: () => dashboardApi.getDashboard(api),
  });
  // Offline the refetch fails at once (retry: false) but the hydrated
  // snapshot stays in `data`: it is shown, with its age, never hidden
  // behind the error (doc 06 §6.2 — staleness is said, not concealed).
  const snapshotAge = useSnapshotAge();

  // The web formats through Intl; doc 06 §4.3 requires a deterministic
  // formatter on device, because Hermes ships a trimmed ICU and the same
  // number can render differently across platforms.

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg },
        ]}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
        }
      >
        <HeaderAccessories />
        <View style={styles.header}>
          <Text style={styles.greeting}>{t("app.dashboard.greeting", { name: greetingName })}</Text>
          <Text style={styles.sub}>{t(me?.isOwner ? "app.dashboard.greetingOwner" : "app.dashboard.greetingStaff")}</Text>
        </View>

        {isLoading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xxl }} />
        ) : error && !data ? (
          <Text style={styles.error}>
            {error instanceof ApiError ? error.message : t("app.activity.errors.loadFailed")}
          </Text>
        ) : data ? (
          <>
            {error ? (
              <Text style={styles.stale}>
                {snapshotAge === null
                  ? t("mobile.offline.staleDataUnknownAge")
                  : t("mobile.offline.staleData", { ago: formatAge(snapshotAge) })}
              </Text>
            ) : null}
            <View style={styles.grid}>
              <View style={styles.gridRow}>
                <StatCard
                  title={t("app.dashboard.stats.todaySales")}
                  value={money(data.stats.todayRevenue)}
                  icon={CurrencyDollar}
                  color="success"
                />
                <StatCard
                  title={t("app.dashboard.stats.itemCount")}
                  value={String(data.stats.productCount)}
                  icon={Package}
                  color="accent"
                />
              </View>
              <View style={styles.gridRow}>
                <StatCard
                  title={t("app.dashboard.stats.monthSales")}
                  value={money(data.stats.monthRevenue)}
                  icon={ShoppingCart}
                  color="accent"
                />
                <StatCard
                  title={t("app.dashboard.stats.monthReturns")}
                  value={String(data.stats.monthReturns)}
                  icon={ArrowCounterClockwise}
                  color="danger"
                />
              </View>
            </View>

            <StockAlerts items={data.lowStock.items} />
          </>
        ) : null}
      </ScrollView>

    </View>
  );
}

/** Seconds → "just now" / "{n}m ago" / "{n}h ago" / "{n}d ago", through the dictionary (no Intl on device). */
function formatAge(seconds: number): string {
  if (seconds < 60) return t("mobile.offline.ageNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("mobile.offline.ageMinutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("mobile.offline.ageHours", { n: hours });
  return t("mobile.offline.ageDays", { n: Math.floor(hours / 24) });
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  header: { gap: 4 },
  greeting: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  sub: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  grid: { gap: spacing.lg },
  gridRow: { flexDirection: "row", gap: spacing.lg },
  error: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger },
  stale: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
});
