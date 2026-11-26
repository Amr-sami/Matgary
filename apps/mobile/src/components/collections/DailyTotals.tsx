import { StyleSheet, Text, View } from "react-native";
import type { collections } from "@matgary/api-client";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { t } from "@/i18n";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

type Summary = collections.CollectionsSummary;
type Bucket = collections.SummaryBucket;

/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

/**
 * The digital "Z" for one day (Q12, doc 15 spec 08 §4.13): one card per
 * receiving account — confirmed / auto-confirmed / pending / rejected (debt,
 * loss), each with count and amount, and its limit warnings — then the day's
 * totals with the cash taken beside transfers. Field for field what
 * GET /api/collections/summary answers (acceptance 15).
 */
export function DailyTotals({ summary, showCredits }: { summary: Summary; showCredits: boolean }) {
  const accounts = summary.accounts.filter((a) => isActive(a, showCredits));
  if (accounts.length === 0 && summary.totals.cashRemainder === 0) {
    return (
      <Card>
        <EmptyState title={t("app.collections.totals.empty")} compact />
      </Card>
    );
  }
  return (
    <View style={styles.list}>
      {accounts.map((a) => (
        <Card key={a.accountId ?? "none"}>
          <View testID={`collections-totals-account-${a.accountId ?? "none"}`} collapsable={false} style={styles.card}>
            <View style={styles.head}>
              <Text numberOfLines={1} style={styles.name}>
                {a.label ?? t("app.collections.inbox.row.noAccount")}
              </Text>
              {a.provider ? (
                <Text numberOfLines={1} style={styles.provider}>
                  {t(`app.collections.vocab.providers.${a.provider}`)}
                </Text>
              ) : null}
            </View>
            {a.limitWarnings.length > 0 ? (
              <View style={styles.badges}>
                {a.limitWarnings.map((w) => (
                  <Badge key={w} label={t(`app.collections.totals.limit.${w}`)} variant="lowstock" />
                ))}
              </View>
            ) : null}
            <Rows b={a} showCredits={showCredits} />
          </View>
        </Card>
      ))}
      <Card title={t("app.collections.totals.total")}>
        <View testID="collections-totals-total" collapsable={false} style={styles.card}>
          <Rows b={summary.totals} showCredits={showCredits} />
          <Row label={t("app.collections.totals.cashRemainder")} amount={summary.totals.cashRemainder} />
        </View>
      </Card>
    </View>
  );
}

function isActive(a: collections.CollectionsSummaryAccount, showCredits: boolean): boolean {
  const any = (b: Bucket) => b.count > 0 || b.amount !== 0;
  return (
    any(a.confirmed) ||
    any(a.autoConfirmed) ||
    any(a.pending) ||
    any(a.rejectedDebt) ||
    any(a.rejectedLoss) ||
    (showCredits && any(a.unmatchedCredits)) ||
    a.limitWarnings.length > 0
  );
}

function Rows({
  b,
  showCredits,
}: {
  b: Pick<collections.CollectionsSummaryAccount, "confirmed" | "autoConfirmed" | "pending" | "rejectedDebt" | "rejectedLoss" | "unmatchedCredits">;
  showCredits: boolean;
}) {
  return (
    <View style={styles.rows}>
      <Row label={t("app.collections.totals.confirmed")} bucket={b.confirmed} tone="success" />
      {b.autoConfirmed.count > 0 ? <Row label={t("app.collections.totals.autoConfirmed")} bucket={b.autoConfirmed} tone="success" /> : null}
      <Row label={t("app.collections.totals.pending")} bucket={b.pending} tone="warning" />
      {b.rejectedDebt.count > 0 ? <Row label={t("app.collections.totals.rejectedDebt")} bucket={b.rejectedDebt} tone="danger" /> : null}
      {b.rejectedLoss.count > 0 ? <Row label={t("app.collections.totals.rejectedLoss")} bucket={b.rejectedLoss} tone="danger" /> : null}
      {/* M2 (spec 08 §4.11 "Totals"): bank messages with no sale yet, only with
          features.collectionsIngest. Not money the shop has booked, so no tone. */}
      {showCredits ? <Row label={t("app.collections.totals.unmatchedCredits")} bucket={b.unmatchedCredits} /> : null}
    </View>
  );
}

function Row({
  label,
  bucket,
  amount,
  tone,
}: {
  label: string;
  bucket?: Bucket;
  amount?: number;
  tone?: "success" | "warning" | "danger";
}) {
  const value = bucket ? bucket.amount : amount ?? 0;
  return (
    <View style={styles.row}>
      <View style={styles.rowLabel}>
        <Text style={styles.label}>{label}</Text>
        {bucket ? (
          <Text style={styles.count}>
            {t(`app.collections.totals.count${countForm(bucket.count)}`, { n: bucket.count })}
          </Text>
        ) : null}
      </View>
      <Text
        style={[
          styles.amount,
          tone === "success" && styles.success,
          tone === "warning" && value > 0 && styles.warning,
          tone === "danger" && styles.danger,
        ]}
      >
        {money(value)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  card: { gap: spacing.sm },
  head: { gap: 2 },
  name: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 16, color: colors.text },
  provider: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  rows: { gap: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, minHeight: 36 },
  rowLabel: { flexShrink: 1, gap: 0 },
  label: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.text },
  count: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  amount: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  success: { color: colors.successStrong },
  warning: { color: colors.warningStrong },
  danger: { color: colors.danger },
});
