// /financials — mobile Overview. Reads the same /api/financials/overview the
// web does and presents 6 headline KPIs + navigation to every Financials
// sub-screen + a revenue-vs-expenses trend chart + the Money In/Out card
// (with the "not P&L" disclaimer).
//
// The screen does no accounting: every number comes from the server. The
// preset chips + custom date range plumb through to each sub-screen via the
// shared PresetChips component.

import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ArrowsClockwiseIcon as ArrowsClockwise } from "phosphor-react-native/src/icons/ArrowsClockwise";
import { CaretRightIcon as CaretRight } from "phosphor-react-native/src/icons/CaretRight";
import { CoinsIcon as Coins } from "phosphor-react-native/src/icons/Coins";
import { FunnelIcon as Funnel } from "phosphor-react-native/src/icons/Funnel";
import { HandCoinsIcon as HandCoins } from "phosphor-react-native/src/icons/HandCoins";
import { ReceiptIcon as Receipt } from "phosphor-react-native/src/icons/Receipt";
import { TrendUpIcon as TrendUp } from "phosphor-react-native/src/icons/TrendUp";
import { WalletIcon as Wallet } from "phosphor-react-native/src/icons/Wallet";

import { Screen } from "@/components/layout/Screen";
import { Card } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import {
  SkeletonListRow,
  SkeletonStatCard,
} from "@/components/ui/skeleton";
import { PresetChips } from "@/components/financials/PresetChips";
import { FinanceTrendChart } from "@/components/financials/FinanceTrendChart";
import { OpexByGroupBars } from "@/components/financials/OpexByGroupBars";
import {
  useFinancialOverview,
  useFinancialPnL,
  useFinancialTrends,
  type FinancialsRange,
} from "@/hooks/useFinance";
import { useSession } from "@/stores/session";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

export default function FinancialsOverviewScreen() {
  const router = useRouter();
  const [range, setRange] = useState<FinancialsRange>({ preset: "this_month" });

  const me = useSession((s) => s.me);
  const perms = new Set(me?.permissions ?? []);
  const canView = me?.isOwner || perms.has("view_financials");
  const canManageExpenses = me?.isOwner || perms.has("manage_expenses");
  const canManageMovements = me?.isOwner || perms.has("manage_money_movements");
  const canManageCategories = me?.isOwner || perms.has("manage_expense_categories");
  const canManageRecurring = me?.isOwner || perms.has("manage_recurring_expenses");

  const overview = useFinancialOverview(range);
  const trends = useFinancialTrends(range);
  const pnl = useFinancialPnL(range);

  if (!canView) {
    return (
      <Screen title={t("app.financials.title")}>
        <Card>
          <Text style={styles.err}>
            {t("mobile.financials.expenses.noViewPermission")}
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t("app.financials.title")}>
      <PresetChips value={range} onChange={setRange} />

      {overview.isPending && !overview.data ? (
        <>
          <View style={styles.statRow}>
            <SkeletonStatCard style={{ flex: 1 }} />
            <SkeletonStatCard style={{ flex: 1 }} />
          </View>
          <View style={styles.statRow}>
            <SkeletonStatCard style={{ flex: 1 }} />
            <SkeletonStatCard style={{ flex: 1 }} />
          </View>
          <SkeletonListRow count={3} avatarSize={0} trailingWidth={56} height={44} />
        </>
      ) : overview.error && !overview.data ? (
        <Card>
          <Text style={styles.err}>{t("mobile.financials.loadFailed")}</Text>
        </Card>
      ) : !overview.data ? null : (
        <>
          <View style={styles.statRow}>
            <StatCard
              title={t("app.financials.kpi.netSales")}
              value={money(overview.data.netSales)}
              icon={Coins}
              color="accent"
            />
            <StatCard
              title={t("app.financials.kpi.cogs")}
              value={money(overview.data.cogs)}
              icon={Receipt}
              color="accent"
            />
          </View>
          <View style={styles.statRow}>
            <StatCard
              title={t("app.financials.kpi.grossProfit")}
              value={money(overview.data.grossProfit)}
              icon={TrendUp}
              color={overview.data.grossProfit >= 0 ? "success" : "danger"}
            />
            <StatCard
              title={t("app.financials.kpi.operatingExpenses")}
              value={money(overview.data.operatingExpenses)}
              icon={Wallet}
              color="danger"
            />
          </View>
          <View style={styles.statRow}>
            <StatCard
              title={t("app.financials.kpi.netProfit")}
              value={money(overview.data.netProfit)}
              icon={TrendUp}
              color={overview.data.netProfit >= 0 ? "success" : "danger"}
            />
            <StatCard
              title={t("app.financials.kpi.netMargin")}
              value={`${(overview.data.netMargin * 100).toFixed(1)}%`}
              icon={TrendUp}
              color={overview.data.netMargin >= 0 ? "success" : "danger"}
            />
          </View>

          {/* Revenue-vs-Expenses area chart (gated by seesProfit for the net
              profit line). Hidden entirely when there are no trend points. */}
          {trends.data && trends.data.data.length > 0 ? (
            <FinanceTrendChart
              points={trends.data.data}
              seesProfit={trends.data.seesProfit}
            />
          ) : null}

          {/* OpEx by group — small horizontal-ish bar chart on mobile. */}
          {pnl.data && pnl.data.data.operatingExpensesByGroup.length > 0 ? (
            <OpexByGroupBars
              groups={pnl.data.data.operatingExpensesByGroup.map((g) => ({
                nameAr: g.groupNameAr,
                nameEn: g.groupNameEn,
                total: g.total,
              }))}
            />
          ) : null}

          <NavRow
            icon={<TrendUp size={22} color={colors.accent} weight="bold" />}
            label={t("mobile.financials.view.pnl")}
            onPress={() => router.push("/financials/pnl" as never)}
          />

          {canManageExpenses ? (
            <NavRow
              icon={<Receipt size={22} color={colors.accent} weight="bold" />}
              label={t("mobile.financials.view.expenses")}
              onPress={() => router.push("/financials/expenses" as never)}
            />
          ) : null}

          {canManageMovements ? (
            <NavRow
              icon={<HandCoins size={22} color={colors.accent} weight="bold" />}
              label={t("mobile.financials.view.moneyMovements")}
              onPress={() => router.push("/financials/money-movements" as never)}
            />
          ) : null}

          {canManageRecurring ? (
            <NavRow
              icon={<ArrowsClockwise size={22} color={colors.accent} weight="bold" />}
              label={t("mobile.financials.view.recurring")}
              onPress={() => router.push("/financials/recurring" as never)}
            />
          ) : null}

          <NavRow
            icon={<Funnel size={22} color={colors.accent} weight="bold" />}
            label={t("mobile.financials.view.profitability")}
            onPress={() => router.push("/financials/profitability" as never)}
          />

          {canManageCategories ? (
            <NavRow
              icon={<Receipt size={22} color={colors.accent} weight="regular" />}
              label={t("mobile.financials.view.categories")}
              onPress={() => router.push("/financials/categories" as never)}
            />
          ) : null}

          <Card>
            <Text style={styles.sectionTitle}>
              {t("app.financials.kpi.moneyIn")} / {t("app.financials.kpi.moneyOut")}
            </Text>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>
                {t("app.financials.kpi.moneyIn")}
              </Text>
              <Text style={styles.rowValue}>{money(overview.data.moneyIn)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>
                {t("app.financials.kpi.moneyOut")}
              </Text>
              <Text style={styles.rowValue}>{money(overview.data.moneyOut)}</Text>
            </View>
            <Text style={styles.hint}>
              {t("mobile.financials.movementsNote")}
            </Text>
          </Card>
        </>
      )}
    </Screen>
  );
}

function NavRow({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.linkCard} accessibilityRole="button">
      <View style={styles.linkLeft}>
        {icon}
        <Text style={styles.linkText}>{label}</Text>
      </View>
      <CaretRight size={16} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: "row", gap: spacing.md },
  err: { ...RTL_TEXT, fontSize: 14, color: colors.danger },
  linkCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  linkLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    flex: 1,
  },
  linkText: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
  sectionTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: spacing.xs,
  },
  rowLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
  },
  rowValue: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  hint: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
});
