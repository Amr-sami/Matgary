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

  const { data, error, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["dashboard", activeBranchId],
    queryFn: () => dashboardApi.getDashboard(api),
  });

  // The web formats through Intl; doc 06 §4.3 requires a deterministic
  // formatter on device, because Hermes ships a trimmed ICU and the same
  // number can render differently across platforms.
  const money = (value: number) =>
    `${value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ج.م`;

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
        <View style={styles.header}>
          <Text style={styles.greeting}>{t("app.dashboard.greeting", { name: me?.tenant.name ?? "" })}</Text>
          <Text style={styles.sub}>{t(me?.isOwner ? "app.dashboard.greetingOwner" : "app.dashboard.greetingStaff")}</Text>
        </View>

        {isLoading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xxl }} />
        ) : error ? (
          <Text style={styles.error}>
            {error instanceof ApiError ? error.message : t("app.activity.errors.loadFailed")}
          </Text>
        ) : data ? (
          <>
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
});
