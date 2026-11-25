import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePdfIcon as FilePdf } from "phosphor-react-native/src/icons/FilePdf";
import { ShareNetworkIcon as ShareNetwork } from "phosphor-react-native/src/icons/ShareNetwork";
import { inventoryCounts as api } from "@matgary/api-client";

import { api as client } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSession } from "@/stores/session";
import { errorText } from "@/lib/errors";
import {
  InventoryCountShareUnavailableError,
  shareInventoryCountPdf,
} from "@/inventory-count/share";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

type Tab = "shortage" | "overage" | "matched" | "notCounted";

/**
 * Review + confirm.
 * - Groups counted lines into matched/shortage/overage (+ "not counted" for
 *   context) with tab-style filter chips.
 * - Confirm button calls POST /confirm with an Idempotency-Key so a replay is
 *   safe. On 409 COUNT_HAS_INVALID_LINES the sheet shows the exceptions
 *   screen; the owner must DELETE the flagged lines before retrying.
 */
export default function InventoryCountReviewScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ id: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const perms = useSession((s) => s.me?.permissions);
  const canManage = perms == null || perms.includes("manage_inventory_counts");

  const [tab, setTab] = useState<Tab>("shortage");

  const q = useQuery({
    queryKey: ["inventory-count", id],
    enabled: !!id,
    queryFn: () => api.getCount(client, id!),
  });

  const confirm = useMutation({
    mutationFn: () => api.confirmCount(client, id!),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["inventory-count", id] });
      void qc.invalidateQueries({ queryKey: ["inventory-counts"] });
      router.replace(`/inventory-count/${id}?confirmedAt=${encodeURIComponent(res.confirmedAt)}`);
    },
  });

  // Post-confirm report: metadata (filename, financial impact) + lets the
  // Share button fire the server-generated PDF through the native share sheet.
  const report = useQuery({
    queryKey: ["inventory-count", "report", id],
    enabled: !!id && q.data?.count.status === "completed",
    queryFn: () => api.getCountReport(client, id!),
  });

  const share = useMutation({
    mutationFn: async () => {
      if (!report.data) throw new Error("report not loaded");
      const d = new Date(
        report.data.header.confirmedAt ?? report.data.header.createdAt,
      );
      const pad = (n: number) => String(n).padStart(2, "0");
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const safeRef = report.data.header.ref.replace(/[^A-Z0-9-]/gi, "");
      const filename = `Storo_Inventory_Count_${safeRef}_${date}.pdf`;
      await shareInventoryCountPdf({ countId: id!, filename });
    },
    onError: (err) => {
      if (err instanceof InventoryCountShareUnavailableError) {
        Alert.alert(t("mobile.inventoryCount.report.shareUnavailable"));
        return;
      }
      Alert.alert(
        t("mobile.inventoryCount.report.shareFailed"),
        errorText(err, ""),
      );
    },
  });

  const header = (
    <View style={styles.header}>
      <HeaderAccessories />
      <BackLink
        label={t("mobile.inventoryCount.backToCount")}
        onPress={() => router.navigate(`/inventory-count/${id}`)}
      />
    </View>
  );

  if (!canManage) {
    return (
      <Screen header={header}>
        <EmptyState title={t("mobile.common.forbidden")} />
      </Screen>
    );
  }

  const lines = q.data?.lines ?? [];
  const partitioned = useMemo(() => {
    const matched: typeof lines = [];
    const shortage: typeof lines = [];
    const overage: typeof lines = [];
    const notCounted: typeof lines = [];
    for (const l of lines) {
      if (l.countedQty == null) {
        notCounted.push(l);
      } else {
        const d = l.countedQty - l.baselineQty;
        if (d === 0) matched.push(l);
        else if (d < 0) shortage.push(l);
        else overage.push(l);
      }
    }
    return { matched, shortage, overage, notCounted };
  }, [lines]);

  const current =
    tab === "shortage"
      ? partitioned.shortage
      : tab === "overage"
        ? partitioned.overage
        : tab === "matched"
          ? partitioned.matched
          : partitioned.notCounted;

  const invalidDetails = api.invalidLinesDetailsOf(confirm.error);

  return (
    <Screen header={header}>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>{t("mobile.inventoryCount.review.title")}</Text>
        {q.data ? (
          <Text style={styles.subtitle}>
            {t("mobile.inventoryCount.review.subtitle", {
              counted: q.data.summary.linesCounted,
              total: q.data.summary.scopeProductCount,
            })}
          </Text>
        ) : null}
      </View>

      {q.isPending && !q.data ? (
        <SkeletonListRow count={5} avatarSize={0} trailingWidth={56} height={56} />
      ) : !q.data ? (
        <EmptyState title={t("mobile.inventoryCount.notFound")} />
      ) : (
        <View style={styles.stack}>
          <Card title={t("mobile.inventoryCount.review.breakdown")}>
            <View style={styles.summaryGrid}>
              <SummaryCell label={t("mobile.inventoryCount.summary.matched")} value={q.data.summary.linesMatched} />
              <SummaryCell label={t("mobile.inventoryCount.summary.shortage")} value={q.data.summary.linesShortage} tone="danger" />
              <SummaryCell label={t("mobile.inventoryCount.summary.overage")} value={q.data.summary.linesOverage} tone="success" />
            </View>
            <Text style={styles.footnote}>
              {t("mobile.inventoryCount.review.netAdjustment", {
                n: q.data.summary.netAdjustment > 0 ? `+${q.data.summary.netAdjustment}` : String(q.data.summary.netAdjustment),
              })}
            </Text>
          </Card>

          <View style={styles.tabs}>
            {(["shortage", "overage", "matched", "notCounted"] as Tab[]).map((k) => (
              <Pressable
                key={k}
                onPress={() => setTab(k)}
                style={({ pressed }) => [
                  styles.tab,
                  tab === k && styles.tabActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.tabText, tab === k && styles.tabTextActive]}>
                  {t(`mobile.inventoryCount.review.tab.${k}`)}
                </Text>
                <Text style={[styles.tabCount, tab === k && styles.tabTextActive]}>
                  {k === "shortage"
                    ? partitioned.shortage.length
                    : k === "overage"
                      ? partitioned.overage.length
                      : k === "matched"
                        ? partitioned.matched.length
                        : partitioned.notCounted.length}
                </Text>
              </Pressable>
            ))}
          </View>

          <Card>
            {current.length === 0 ? (
              <Text style={styles.empty}>{t("mobile.inventoryCount.review.emptyBucket")}</Text>
            ) : (
              current.map((l) => {
                const diff =
                  l.countedQty == null ? null : l.countedQty - l.baselineQty;
                const diffColor =
                  diff == null || diff === 0
                    ? colors.textSecondary
                    : diff > 0
                      ? colors.successStrong
                      : colors.danger;
                return (
                  <Pressable
                    key={l.id}
                    style={({ pressed }) => [styles.lineRow, pressed && styles.pressed]}
                    onPress={() => router.push(`/inventory-count/${id}`)}
                  >
                    <View style={styles.rowBody}>
                      <Text numberOfLines={1} style={styles.rowName}>
                        {l.productName ?? t("mobile.inventoryCount.deletedProduct")}
                      </Text>
                      <Text numberOfLines={1} style={styles.rowMeta}>
                        {t("mobile.inventoryCount.row.system", { n: l.baselineQty })}
                        {l.countedQty != null
                          ? ` · ${t("mobile.inventoryCount.row.counted", { n: l.countedQty })}`
                          : ""}
                      </Text>
                    </View>
                    {diff != null ? (
                      <Text style={[styles.diffText, { color: diffColor }]}>
                        {diff > 0 ? `+${diff}` : String(diff)}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </Card>

          {invalidDetails ? (
            <View style={styles.exceptionsBanner}>
              <Text style={styles.exceptionsTitle}>
                {t("mobile.inventoryCount.review.exceptionsTitle")}
              </Text>
              <Text style={styles.exceptionsBody}>
                {t("mobile.inventoryCount.review.exceptionsBody", {
                  n: invalidDetails.invalidProductIds.length,
                })}
              </Text>
            </View>
          ) : confirm.error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>
                {errorText(confirm.error, t("mobile.inventoryCount.review.confirmFailed"))}
              </Text>
            </View>
          ) : null}

          {q.data.count.status === "completed" ? (
            <>
              <View style={styles.confirmedBanner}>
                <Text style={styles.confirmedText}>
                  {t("mobile.inventoryCount.review.alreadyConfirmed")}
                </Text>
              </View>

              <Card>
                <View style={styles.reportHead}>
                  <FilePdf size={22} color={colors.accent} />
                  <View style={styles.reportHeadBody}>
                    <Text style={styles.reportTitle}>
                      {t("mobile.inventoryCount.report.title")}
                    </Text>
                    {report.data ? (
                      <Text style={styles.reportMeta}>
                        {report.data.header.ref}
                        {report.data.summary.financialImpact != null
                          ? ` · ${t("mobile.inventoryCount.report.impact", {
                              v:
                                report.data.summary.financialImpact < 0
                                  ? `−${Math.abs(report.data.summary.financialImpact).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                  : `+${report.data.summary.financialImpact.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                            })}`
                          : ""}
                      </Text>
                    ) : (
                      <Text style={styles.reportMeta}>
                        {t("mobile.inventoryCount.report.subtitle")}
                      </Text>
                    )}
                  </View>
                </View>

                <View style={styles.reportActions}>
                  <Button
                    label={t("mobile.inventoryCount.report.shareBtn")}
                    onPress={() => share.mutate()}
                    loading={share.isPending || report.isLoading}
                    disabled={share.isPending || !report.data}
                    icon={ShareNetwork}
                    testID="count-report-share-btn"
                  />
                </View>
              </Card>
            </>
          ) : (
            <Button
              label={t("mobile.inventoryCount.review.confirmCount")}
              onPress={() => confirm.mutate()}
              loading={confirm.isPending}
              disabled={confirm.isPending || q.data.summary.linesCounted === 0}
              testID="count-confirm-btn"
            />
          )}
        </View>
      )}
    </Screen>
  );
}

function SummaryCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger" | "success";
}) {
  const color =
    tone === "danger" ? colors.danger : tone === "success" ? colors.successStrong : colors.text;
  return (
    <View style={styles.summaryCell}>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs, alignItems: "flex-start" },
  titleBlock: { gap: spacing.xs, marginBottom: spacing.md },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  stack: { gap: spacing.md },

  summaryGrid: { flexDirection: "row", gap: spacing.sm },
  summaryCell: {
    flex: 1,
    alignItems: "center",
    gap: 2,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  summaryValue: {
    fontFamily: fonts.bold,
    fontSize: 20,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  summaryLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  footnote: {
    marginTop: spacing.sm,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },

  tabs: {
    flexDirection: "row",
    gap: spacing.xs,
    flexWrap: "wrap",
  },
  tab: {
    flexDirection: "row",
    gap: spacing.xs,
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  tabActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  tabText: { fontFamily: fonts.medium, fontSize: 13, color: colors.text, ...RTL_TEXT },
  tabCount: {
    fontFamily: fonts.bold,
    fontSize: 13,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  tabTextActive: { color: colors.accent },

  empty: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  lineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, ...RTL_TEXT },
  rowMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  diffText: { fontFamily: fonts.bold, fontSize: 14, fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.85 },

  errorBanner: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerLight,
  },
  errorText: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },

  exceptionsBanner: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningLight,
    borderWidth: 1,
    borderColor: colors.warning,
    gap: 4,
  },
  exceptionsTitle: {
    fontFamily: fonts.bold,
    fontSize: 14,
    color: colors.warningStrong,
    ...RTL_TEXT,
  },
  exceptionsBody: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.warningStrong,
    ...RTL_TEXT,
  },

  confirmedBanner: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.successLight,
  },
  confirmedText: { fontFamily: fonts.medium, fontSize: 13, color: colors.successStrong, ...RTL_TEXT },

  reportHead: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.sm },
  reportHeadBody: { flex: 1, gap: 2 },
  reportTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    ...RTL_TEXT,
  },
  reportMeta: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  reportActions: { gap: spacing.sm },
});
