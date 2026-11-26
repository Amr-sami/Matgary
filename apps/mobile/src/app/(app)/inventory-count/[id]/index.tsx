import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarcodeIcon as Barcode } from "phosphor-react-native/src/icons/Barcode";
import { MagnifyingGlassIcon as MagnifyingGlass } from "phosphor-react-native/src/icons/MagnifyingGlass";
import {
  ApiError,
  catalog,
  inventoryCounts as api,
  type Product,
} from "@matgary/api-client";
type CountLine = api.CountLine;
const outOfScopeDetailsOf = api.outOfScopeDetailsOf;
// (invalidLinesDetailsOf is used by the exceptions screen, not here.)

import { api as client } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { ScannerSheet } from "@/components/scanner/ScannerSheet";
import { CountLineSheet } from "@/components/inventory-count/CountLineSheet";
import { useSession } from "@/stores/session";
import { errorText } from "@/lib/errors";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";
import { t } from "@/i18n";

// Invalid-lines detection helper removed — using api-client's own.

/**
 * The counting screen — the shopkeeper's primary workspace. Scanner stays
 * ready between items; manual search is one tap away; the line list groups
 * To-review / Matched so the owner sees progress at a glance.
 *
 * Deep links from push / share land here with `?id=<countId>`; the Review
 * and Complete screens are plain navigations from here.
 */
export default function InventoryCountCountingScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ id: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const perms = useSession((s) => s.me?.permissions);
  const canManage = perms == null || perms.includes("manage_inventory_counts");

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanStatus, setScanStatus] = useState<{
    message?: string;
    tone?: "info" | "error" | "success";
    notFound?: string | null;
  }>({});
  const [sheet, setSheet] = useState<
    | null
    | {
        source: "scan" | "manual";
        product: { id: string; name: string; sku: string | null };
        line: CountLine | null;
        /** Set when the server returned OUT_OF_SCOPE — the sheet shows the
         *  "add anyway?" banner; pressing Add sends `force=true`. */
        outOfScope?: { currentQty: number };
      }
  >(null);
  const [search, setSearch] = useState("");

  const q = useQuery({
    queryKey: ["inventory-count", id],
    enabled: !!id,
    queryFn: () => api.getCount(client, id!),
    refetchOnWindowFocus: false,
  });

  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(client),
  });

  const upsert = useMutation({
    mutationFn: (v: { productId: string; countedQty: number; source: "scan" | "manual"; force?: boolean }) =>
      api.upsertLine(client, id!, v.productId, {
        countedQty: v.countedQty,
        source: v.source,
        force: v.force,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-count", id] });
      setSheet(null);
    },
    onError: (err) => {
      const oos = outOfScopeDetailsOf(err);
      if (oos && sheet) {
        setSheet({ ...sheet, outOfScope: { currentQty: oos.currentQty } });
      }
    },
  });

  const removeLine = useMutation({
    mutationFn: (productId: string) => api.deleteLine(client, id!, productId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-count", id] });
      setSheet(null);
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelCount(client, id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-counts", "active"] });
      router.replace("/inventory-count");
    },
  });

  const lines = q.data?.lines ?? [];
  const summary = q.data?.summary;

  // Progress and partition
  const progress = summary ? Math.min(1, summary.linesCounted / Math.max(1, summary.scopeProductCount)) : 0;
  const toReview = lines.filter((l) => l.countedQty !== null);
  const notYet = lines.filter((l) => l.countedQty === null);

  // Manual search results
  const searchMatches = useMemo(() => {
    const qstr = search.trim().toLowerCase();
    if (!qstr) return [];
    const src = products.data ?? [];
    return src
      .filter(
        (p) =>
          p.name.toLowerCase().includes(qstr) ||
          (p.sku ?? "").toLowerCase().includes(qstr) ||
          (p.barcode ?? "").toLowerCase().includes(qstr),
      )
      .slice(0, 20);
  }, [products.data, search]);

  async function onScan(code: string): Promise<void> {
    setScanStatus({ message: t("mobile.inventoryCount.scanner.looking"), tone: "info" });
    try {
      const { product } = await catalog.findProductByBarcode(client, code);
      if (!product) {
        setScanStatus({
          message: t("mobile.inventoryCount.scanner.notFound", { code }),
          tone: "error",
          notFound: code,
        });
        return;
      }
      openSheetForProduct(product, "scan");
      setScanStatus({});
    } catch (err) {
      setScanStatus({ message: errorText(err, t("mobile.common.serverError")), tone: "error" });
    }
  }

  function openSheetForProduct(product: Product, source: "scan" | "manual") {
    const line = lines.find((l) => l.productId === product.id) ?? null;
    setSheet({
      source,
      product: { id: product.id, name: product.name, sku: product.sku ?? product.barcode ?? null },
      line,
    });
    setScannerOpen(false);
  }

  function openSheetForLine(line: CountLine) {
    setSheet({
      source: "manual",
      product: { id: line.productId, name: line.productName ?? "?", sku: line.productSku ?? null },
      line,
    });
  }

  const header = (
    <View style={styles.header}>
      <HeaderAccessories />
      <BackLink
        label={t("mobile.inventoryCount.title")}
        onPress={() => router.navigate("/inventory-count")}
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

  const status = q.data?.count.status;
  const readOnly = status === "completed" || status === "cancelled";

  return (
    <Screen header={header}>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>
          {q.data ? scopeLabel(q.data.count.scopeKind, q.data.count.scopeValue) : t("mobile.inventoryCount.title")}
        </Text>
        {summary ? (
          <Text style={styles.subtitle}>
            {t("mobile.inventoryCount.counting.progress", {
              counted: summary.linesCounted,
              total: summary.scopeProductCount,
              pct: Math.round(progress * 100),
            })}
          </Text>
        ) : null}
      </View>

      {q.isPending && !q.data ? (
        <SkeletonListRow count={4} avatarSize={0} trailingWidth={48} height={64} />
      ) : !q.data ? (
        <EmptyState title={t("mobile.inventoryCount.notFound")} />
      ) : (
        <View style={styles.stack}>
          {/* Progress bar */}
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` as `${number}%` }]} />
          </View>

          {/* Scanner + search row */}
          {!readOnly ? (
            <>
              <Pressable
                style={({ pressed }) => [styles.scanBtn, pressed && styles.pressed]}
                onPress={() => setScannerOpen(true)}
                accessibilityRole="button"
                testID="count-scan-btn"
              >
                <Barcode size={22} color={colors.onAccent} />
                <Text style={styles.scanBtnText}>{t("mobile.inventoryCount.scanner.scan")}</Text>
              </Pressable>

              <View style={styles.searchRow}>
                <MagnifyingGlass size={18} color={colors.textSecondary} />
                <Field
                  label=""
                  value={search}
                  onChangeText={setSearch}
                  placeholder={t("mobile.inventoryCount.search.placeholder")}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              {searchMatches.length > 0 ? (
                <Card>
                  {searchMatches.map((p) => {
                    const line = lines.find((l) => l.productId === p.id);
                    return (
                      <Pressable
                        key={p.id}
                        style={({ pressed }) => [styles.searchMatch, pressed && styles.pressed]}
                        onPress={() => openSheetForProduct(p, "manual")}
                      >
                        <View style={styles.rowBody}>
                          <Text numberOfLines={1} style={styles.rowName}>{p.name}</Text>
                          <Text numberOfLines={1} style={styles.rowMeta}>
                            {p.sku ?? ""}{line?.countedQty != null ? ` · ${t("mobile.inventoryCount.row.counted", { n: line.countedQty })}` : ""}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </Card>
              ) : null}
            </>
          ) : null}

          {/* Summary bar */}
          {summary ? (
            <Card title={t("mobile.inventoryCount.summary.title")}>
              <View style={styles.summaryGrid}>
                <SummaryCell label={t("mobile.inventoryCount.summary.matched")} value={summary.linesMatched} />
                <SummaryCell label={t("mobile.inventoryCount.summary.shortage")} value={summary.linesShortage} tone="danger" />
                <SummaryCell label={t("mobile.inventoryCount.summary.overage")} value={summary.linesOverage} tone="success" />
              </View>
            </Card>
          ) : null}

          {/* Counted lines */}
          {toReview.length > 0 ? (
            <Card title={t("mobile.inventoryCount.lists.counted")}>
              {toReview.map((l) => (
                <LineRow key={l.id} line={l} onPress={() => openSheetForLine(l)} />
              ))}
            </Card>
          ) : null}

          {/* Not yet counted */}
          {notYet.length > 0 ? (
            <Card title={t("mobile.inventoryCount.lists.notYet", { n: notYet.length })}>
              {notYet.slice(0, 50).map((l) => (
                <LineRow key={l.id} line={l} onPress={() => openSheetForLine(l)} />
              ))}
              {notYet.length > 50 ? (
                <Text style={styles.hint}>{t("mobile.inventoryCount.lists.moreHint", { n: notYet.length - 50 })}</Text>
              ) : null}
            </Card>
          ) : null}

          {/* Actions */}
          {!readOnly ? (
            <View style={styles.actions}>
              <Button
                label={t("mobile.inventoryCount.actions.review")}
                onPress={() => router.push(`/inventory-count/${id}/review`)}
                disabled={!summary || summary.linesCounted === 0}
                testID="count-review-btn"
              />
              <Button
                label={t("mobile.inventoryCount.actions.cancelCount")}
                onPress={() => cancel.mutate()}
                variant="ghost"
                loading={cancel.isPending}
                testID="count-cancel-btn"
              />
            </View>
          ) : null}
        </View>
      )}

      {/* Scanner — continuous mode so the shopkeeper keeps scanning */}
      <ScannerSheet
        visible={scannerOpen}
        onClose={() => {
          setScannerOpen(false);
          setScanStatus({});
        }}
        onScan={(code) => void onScan(code)}
        mode="continuous"
        message={scanStatus.message}
        tone={scanStatus.tone}
        notFound={
          scanStatus.notFound
            ? {
                code: scanStatus.notFound,
                onAdd: () => {
                  setScannerOpen(false);
                  setScanStatus({});
                  router.push(`/add-product?sku=${encodeURIComponent(scanStatus.notFound ?? "")}`);
                },
                onDismiss: () => setScanStatus({}),
              }
            : null
        }
      />

      {/* Count line sheet */}
      {sheet ? (
        <CountLineSheet
          visible={!!sheet}
          onClose={() => setSheet(null)}
          productName={sheet.product.name}
          productSku={sheet.product.sku}
          baselineQty={sheet.line?.baselineQty ?? sheet.outOfScope?.currentQty ?? 0}
          initialCountedQty={sheet.line?.countedQty ?? null}
          source={sheet.source}
          saving={upsert.isPending || removeLine.isPending}
          errorText={
            upsert.error && !(upsert.error instanceof ApiError && upsert.error.code === "OUT_OF_SCOPE")
              ? errorText(upsert.error, t("mobile.inventoryCount.sheet.saveFailed"))
              : null
          }
          outOfScope={!!sheet.outOfScope}
          onAddAnyway={() =>
            upsert.mutate({
              productId: sheet.product.id,
              countedQty: 1,
              source: sheet.source,
              force: true,
            })
          }
          onSave={(counted) =>
            upsert.mutate({
              productId: sheet.product.id,
              countedQty: counted,
              source: sheet.source,
            })
          }
          onRemove={
            sheet.line
              ? () => removeLine.mutate(sheet.product.id)
              : undefined
          }
          testID="count-line-sheet"
        />
      ) : null}
    </Screen>
  );
}

function LineRow({ line, onPress }: { line: CountLine; onPress: () => void }) {
  const diff =
    line.countedQty == null ? null : line.countedQty - line.baselineQty;
  const diffColor =
    diff == null || diff === 0
      ? colors.textSecondary
      : diff > 0
        ? colors.successStrong
        : colors.danger;
  return (
    <Pressable
      style={({ pressed }) => [styles.lineRow, pressed && styles.pressed]}
      onPress={onPress}
      testID="count-line-row"
    >
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={styles.rowName}>
          {line.productName ?? t("mobile.inventoryCount.deletedProduct")}
          {line.addedMidCount ? ` · ${t("mobile.inventoryCount.lineBadge.addedMidCount")}` : ""}
        </Text>
        <Text numberOfLines={1} style={styles.rowMeta}>
          {line.productSku ?? ""}
          {" · "}
          {t("mobile.inventoryCount.row.system", { n: line.baselineQty })}
          {line.countedQty != null
            ? ` · ${t("mobile.inventoryCount.row.counted", { n: line.countedQty })}`
            : ""}
        </Text>
      </View>
      {diff != null ? (
        <View style={styles.diffPill}>
          <Text style={[styles.diffText, { color: diffColor }]}>
            {diff > 0 ? `+${diff}` : String(diff)}
          </Text>
        </View>
      ) : null}
    </Pressable>
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

function scopeLabel(kind: string, value: string | null): string {
  if (kind === "all") return t("mobile.inventoryCount.scope.all");
  if (kind === "category") return t("mobile.inventoryCount.scope.categoryLabel", { value: value ?? "—" });
  if (kind === "brand") return t("mobile.inventoryCount.scope.brandLabel", { value: value ?? "—" });
  return kind;
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs, alignItems: "flex-start" },
  titleBlock: { gap: spacing.xs, marginBottom: spacing.md },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  stack: { gap: spacing.md },
  hint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT, marginTop: spacing.xs },

  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: colors.accent },

  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    minHeight: 48,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
  },
  scanBtnText: { fontFamily: fonts.bold, fontSize: 16, color: colors.onAccent },

  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },

  searchMatch: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },

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
  diffPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: colors.neutralTint,
    flexShrink: 0,
  },
  diffText: { fontFamily: fonts.bold, fontSize: 13, fontVariant: ["tabular-nums"] },

  actions: { gap: spacing.sm, marginTop: spacing.md },
  pressed: { opacity: 0.85 },
});
