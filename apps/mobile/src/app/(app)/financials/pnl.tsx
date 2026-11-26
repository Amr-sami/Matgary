// /financials/pnl — mobile Profit & Loss statement. Reads the same
// /api/financials/pnl endpoint the web uses. view_profit redaction is
// honoured server-side; the mobile UI simply shows em-dash for null fields.
//
// OpEx groups are expandable: tap a group row to reveal its subcategories.
// Default collapsed because a P&L with 9 opex groups × 4+ subcats is noisy on
// a phone — the Owner gets the totals first and drills down when curious.

import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CaretDownIcon as CaretDown } from "phosphor-react-native/src/icons/CaretDown";
import { CaretRightIcon as CaretRight } from "phosphor-react-native/src/icons/CaretRight";

import { Screen } from "@/components/layout/Screen";
import { Card } from "@/components/ui/Card";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { PresetChips } from "@/components/financials/PresetChips";
import { useFinancialPnL, type FinancialsRange } from "@/hooks/useFinance";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

export default function MobilePnLScreen() {
  const [range, setRange] = useState<FinancialsRange>({ preset: "this_month" });
  const q = useFinancialPnL(range);
  const seesProfit = q.data?.seesProfit ?? false;
  const data = q.data?.data;

  return (
    <Screen title={t("app.financials.tabs.pnl")}>
      <PresetChips value={range} onChange={setRange} />

      {q.isPending && !q.data ? (
        <SkeletonListRow count={10} avatarSize={0} trailingWidth={80} height={40} />
      ) : q.error && !q.data ? (
        <Card>
          <Text style={styles.err}>{t("mobile.financials.loadFailed")}</Text>
        </Card>
      ) : !data ? null : (
        <>
          <Section title={t("app.financials.pnl.sectionRevenue")}>
            <Row
              label={t("app.financials.pnl.rowGrossSales")}
              value={money(data.grossSales)}
            />
            <Row
              label={t("app.financials.pnl.rowDiscounts")}
              value={`− ${money(data.discounts)}`}
              negative
            />
            <Row
              label={t("app.financials.pnl.rowReturns")}
              value={`− ${money(data.returnsRevenue)}`}
              negative
            />
            <Divider />
            <Row
              label={t("app.financials.pnl.rowNetSales")}
              value={money(data.netSales)}
              emphasized
            />
          </Section>

          <Section title={t("app.financials.pnl.sectionCogs")}>
            <Row
              label={t("app.financials.pnl.rowProductCosts")}
              value={money(data.cogs)}
            />
            <Divider />
            {seesProfit && data.grossProfit !== null ? (
              <Row
                label={t("app.financials.pnl.rowGrossProfit")}
                value={money(data.grossProfit)}
                emphasized
                positive={data.grossProfit >= 0}
              />
            ) : (
              <Row
                label={t("app.financials.pnl.rowGrossProfit")}
                value="—"
                emphasized
              />
            )}
          </Section>

          <Section title={t("app.financials.pnl.sectionOpex")}>
            {data.operatingExpensesByGroup.map((g) => (
              <OpexGroupRow
                key={g.groupSlug}
                nameAr={g.groupNameAr}
                nameEn={g.groupNameEn}
                total={g.total}
                lines={g.lines}
              />
            ))}
            <Divider />
            <Row
              label={t("app.financials.pnl.rowTotalOpex")}
              value={money(data.operatingExpenses)}
            />
            {seesProfit && data.operatingProfit !== null ? (
              <Row
                label={t("app.financials.pnl.rowOperatingProfit")}
                value={money(data.operatingProfit)}
                emphasized
                positive={data.operatingProfit >= 0}
              />
            ) : (
              <Row
                label={t("app.financials.pnl.rowOperatingProfit")}
                value="—"
                emphasized
              />
            )}
          </Section>

          <Section title={t("app.financials.pnl.sectionOther")}>
            <Row
              label={t("app.financials.pnl.rowOtherIncome")}
              value={money(data.otherIncome)}
            />
            <Row
              label={t("app.financials.pnl.rowOtherExpense")}
              value={`− ${money(data.otherExpense)}`}
              negative
            />
            <Divider />
            {seesProfit && data.netProfit !== null ? (
              <>
                <Row
                  label={t("app.financials.pnl.rowNetProfit")}
                  value={money(data.netProfit)}
                  emphasized
                  positive={data.netProfit >= 0}
                />
                {data.netMargin !== null ? (
                  <Row
                    label={t("app.financials.pnl.rowNetMargin")}
                    value={`${(data.netMargin * 100).toFixed(1)}%`}
                  />
                ) : null}
              </>
            ) : (
              <>
                <Row
                  label={t("app.financials.pnl.rowNetProfit")}
                  value="—"
                  emphasized
                />
                <Text style={styles.redacted}>
                  {t("app.financials.pnl.profitRedacted")}
                </Text>
              </>
            )}
          </Section>
        </>
      )}
    </Screen>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={{ gap: spacing.xs }}>{children}</View>
    </Card>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

function OpexGroupRow({
  nameAr,
  nameEn,
  total,
  lines,
}: {
  nameAr: string;
  nameEn: string;
  total: number;
  lines: { slug: string; nameAr: string; nameEn: string; total: number }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = expanded ? CaretDown : CaretRight;
  return (
    <View>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={styles.groupRow}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        <View style={styles.groupHead}>
          <Icon size={14} color={colors.textSecondary} />
          <Text style={styles.groupLabel} numberOfLines={1}>
            {nameAr || nameEn}
          </Text>
        </View>
        <Text style={styles.groupValue}>{money(total)}</Text>
      </Pressable>
      {expanded
        ? lines.map((l) => (
            <View key={l.slug} style={styles.subRow}>
              <Text style={styles.subLabel} numberOfLines={1}>
                {l.nameAr || l.nameEn}
              </Text>
              <Text style={styles.subValue}>{money(l.total)}</Text>
            </View>
          ))
        : null}
    </View>
  );
}

function Row({
  label,
  value,
  negative,
  emphasized,
  positive,
}: {
  label: string;
  value: string;
  negative?: boolean;
  emphasized?: boolean;
  positive?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text
        style={[
          styles.rowLabel,
          emphasized && { fontFamily: fonts.semibold, color: colors.text },
        ]}
      >
        {label}
      </Text>
      <Text
        style={[
          styles.rowValue,
          negative && { color: colors.danger },
          emphasized &&
            positive === true && { color: colors.success },
          emphasized &&
            positive === false && { color: colors.danger },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  err: { ...RTL_TEXT, fontSize: 14, color: colors.danger },
  sectionTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  rowLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
  },
  rowValue: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  redacted: {
    ...RTL_TEXT,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  groupRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    flex: 1,
  },
  groupLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
    flex: 1,
  },
  groupValue: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  subRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 2,
    paddingStart: spacing.lg,
  },
  subLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    flex: 1,
  },
  subValue: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
});
