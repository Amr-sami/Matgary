import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "phosphor-react-native/src/icons/ArrowCounterClockwise";
import { CoinsIcon as Coins } from "phosphor-react-native/src/icons/Coins";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { ShoppingCartIcon as ShoppingCart } from "phosphor-react-native/src/icons/ShoppingCart";
import { ApiError, dashboard as dashboardApi } from "@matgary/api-client";

import { api } from "@/api/client";
import { usePullRefresh } from "@/components/layout/usePullRefresh";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { money, shortDate } from "@/lib/format";
import { useSnapshotAge } from "@/offline/hydrate";
import { StockAlerts } from "@/components/dashboard/StockAlerts";
import { Badge } from "@/components/ui/Badge";
import { ChevronForward } from "@/components/ui/Chevron";
import { StatCard } from "@/components/ui/StatCard";
import { useSession } from "@/stores/session";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, MIN_TOUCH, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

type RecentSale = dashboardApi.RecentSale;

/**
 * Port of apps/web/app/[lang]/(app)/page.tsx — the dashboard as it actually
 * ships: greeting, a 2×2 KPI grid with the same four metrics, icons and
 * colours, the recent-sales strip, then the stock-alert tile, over the
 * permission-filtered tab bar.
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
  const pull = usePullRefresh(() => refetch(), isRefetching);

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
          <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
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
                  icon={Coins}
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

            <RecentSales items={data.recentSales ?? []} />

            <StockAlerts items={data.lowStock.items} />
          </>
        ) : null}
      </ScrollView>

    </View>
  );
}

/**
 * Port of apps/web/components/dashboard/RecentSalesListServer.tsx. The web
 * renders a 5-column table of the last 10 *lines*; a 390pt phone gets a card
 * list of the last 8 *invoices* (the server folds cart lines), each row a
 * 44pt tap target into the sale detail. "View all" goes to the full,
 * paginated history — this strip is deliberately not scrollable on its own.
 *
 * `items` may be missing on a snapshot hydrated before the field shipped,
 * hence the `?? []` at the call site — an older cache must not blank the
 * whole dashboard.
 */
function RecentSales({ items }: { items: RecentSale[] }) {
  const router = useRouter();
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{t("app.dashboard.recentSales.title")}</Text>
        {items.length > 0 ? (
          <Pressable
            onPress={() => router.push("/sales/history")}
            hitSlop={8}
            accessibilityRole="link"
            style={styles.viewAllHit}
          >
            <Text style={styles.viewAll}>{t("app.common.viewAll")}</Text>
          </Pressable>
        ) : null}
      </View>

      {items.length === 0 ? (
        <Text style={styles.empty}>{t("app.dashboard.recentSales.empty")}</Text>
      ) : (
        <View>
          {items.map((sale, i) => (
            <Pressable
              key={sale.id}
              onPress={() => router.push(`/sales/${sale.id}`)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.row,
                i > 0 && styles.rowDivider,
                pressed && styles.rowPressed,
              ]}
            >
              <View style={styles.rowText}>
                <Text
                  style={[
                    styles.customer,
                    !sale.customerName && !sale.customerPhone && styles.customerWalkIn,
                  ]}
                  numberOfLines={1}
                >
                  {sale.customerName ?? sale.customerPhone ?? t("mobile.dashboard.walkInCustomer")}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {t(`mobile.dashboard.saleMeta${countForm(sale.itemCount)}`, {
                    n: sale.itemCount,
                    when: saleWhen(sale.createdAt),
                  })}
                </Text>
              </View>
              <View style={styles.rowEnd}>
                <Text style={styles.total}>{money(sale.total)}</Text>
                <SaleBadge sale={sale} />
              </View>
              <ChevronForward />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * One status chip per row, mirroring the web's sold/returned column but
 * carrying the payment method too, since that is what a cashier glances for:
 * returned beats everything; an unsettled آجل invoice is a warning; otherwise
 * the method in neutral.
 */
function SaleBadge({ sale }: { sale: RecentSale }) {
  if (sale.isReturned) {
    return <Badge label={t("app.dashboard.recentSales.status.returned")} variant="outofstock" />;
  }
  if (sale.paymentMethod === "deferred" && !sale.isPaid) {
    return <Badge label={t("mobile.dashboard.unpaid")} variant="lowstock" />;
  }
  if (!sale.paymentMethod) return null;
  return (
    <Badge
      label={t(`app.activityLabels.paymentMethods.${sale.paymentMethod}`)}
      variant="neutral"
    />
  );
}

/**
 * Today's sales read as a time ("النهاردة 14:05"), older ones as a date. Both
 * are built by hand — no Intl on Hermes — and the day comparison is in the
 * device's local zone, the same zone the clock on the wall shows.
 */
/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

function saleWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (!sameDay) return shortDate(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return t("mobile.dashboard.todayAt", { time: `${pad(d.getHours())}:${pad(d.getMinutes())}` });
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
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.danger },
  stale: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },

  // Recent sales — same surface as StockAlerts / Card so the two tiles read
  // as siblings.
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevation.card,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // The "view all" hit box below is MIN_TOUCH tall, so the header already
    // carries its own breathing room — no extra margin under it.
    minHeight: MIN_TOUCH,
  },
  cardTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  // hitSlop alone cannot reach 44pt here: RN clips slop to the parent's
  // bounds, and the header row is only one line of text tall.
  viewAllHit: { minHeight: MIN_TOUCH, justifyContent: "center" },
  viewAll: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.accent },
  empty: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: spacing.xl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH + spacing.sm,
    paddingVertical: spacing.sm,
  },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowPressed: { opacity: 0.6 },
  rowText: { flex: 1, gap: 2 },
  customer: { fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  customerWalkIn: { color: colors.textSecondary },
  rowMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  rowEnd: { alignItems: "flex-end", gap: 4 },
  total: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text },
});
