// /financials/money-movements — mobile list + create/void of cash movements.
//
// Money movements track cash in/out but are deliberately EXCLUDED from P&L
// (owner deposit is not revenue; loan principal is not expense). The top
// disclaimer reminds the Owner so the numbers never get confused with
// income and expenses.

import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { ArrowDownLeftIcon as ArrowDownLeft } from "phosphor-react-native/src/icons/ArrowDownLeft";
import { ArrowUpRightIcon as ArrowUpRight } from "phosphor-react-native/src/icons/ArrowUpRight";
import { FunnelIcon as Funnel } from "phosphor-react-native/src/icons/Funnel";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";

import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Sheet, useSheet } from "@/components/ui/Sheet";
import {
  SkeletonListRow,
  SkeletonPaginationFooter,
} from "@/components/ui/skeleton";
import { PresetChips } from "@/components/financials/PresetChips";
import { MoneyMovementFormSheet } from "@/components/financials/MoneyMovementFormSheet";
import {
  directionFor,
  useMoneyMovements,
  useVoidMoneyMovement,
  MONEY_MOVEMENT_KINDS,
  type MoneyMovementKind,
  type MoneyMovementRow,
  type MoneyMovementsFilters,
  type FinancialsRange,
} from "@/hooks/useFinance";
import { useSession } from "@/stores/session";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

type Row =
  | { kind: "row"; mm: MoneyMovementRow }
  | { kind: "footer-loading" };

export default function MoneyMovementsScreen() {
  const [range, setRange] = useState<FinancialsRange>({ preset: "this_month" });
  const [kindFilter, setKindFilter] = useState<MoneyMovementKind | undefined>(undefined);
  const [status, setStatus] = useState<"active" | "voided" | "any">("active");

  const me = useSession((s) => s.me);
  const perms = new Set(me?.permissions ?? []);
  const canManage = me?.isOwner || perms.has("manage_money_movements");
  const canView = me?.isOwner || perms.has("view_financials");

  const form = useSheet();
  const filter = useSheet();
  const voidMut = useVoidMoneyMovement();

  const filters: MoneyMovementsFilters = useMemo(
    () => ({
      from: range.preset === "custom" ? range.from : undefined,
      to: range.preset === "custom" ? range.to : undefined,
      kind: kindFilter,
      status,
      limit: 30,
    }),
    [range, kindFilter, status],
  );

  const q = useMoneyMovements(filters);

  const rows: Row[] = useMemo(() => {
    const all: Row[] = (q.data?.pages ?? []).flatMap((p) =>
      p.data.map((mm) => ({ kind: "row" as const, mm })),
    );
    if (q.isFetchingNextPage) all.push({ kind: "footer-loading" });
    return all;
  }, [q.data, q.isFetchingNextPage]);

  const totals = useMemo(() => {
    const flat = (q.data?.pages ?? []).flatMap((p) => p.data);
    let moneyIn = 0;
    let moneyOut = 0;
    for (const mm of flat) {
      if (mm.voidedAt) continue;
      if (directionFor(mm.kind) === "in") moneyIn += mm.amount;
      else moneyOut += mm.amount;
    }
    return { moneyIn, moneyOut };
  }, [q.data]);

  if (!canView) {
    return (
      <Screen title={t("mobile.financials.moneyMovements.title")}>
        <Card>
          <Text style={styles.err}>{t("mobile.financials.expenses.noViewPermission")}</Text>
        </Card>
      </Screen>
    );
  }

  const onVoid = (mm: MoneyMovementRow) => {
    Alert.alert(
      t("mobile.financials.moneyMovements.voidTitle"),
      t("mobile.financials.moneyMovements.voidPrompt"),
      [
        { text: t("app.common.cancel"), style: "cancel" },
        {
          text: t("mobile.financials.moneyMovements.voidAction"),
          style: "destructive",
          onPress: async () => {
            try {
              await voidMut.mutateAsync({ id: mm.id });
            } catch {
              Alert.alert(t("mobile.financials.moneyMovements.voidFailed"));
            }
          },
        },
      ],
    );
  };

  const renderItem: ListRenderItem<Row> = ({ item }) => {
    if (item.kind === "footer-loading") return <SkeletonPaginationFooter />;
    const mm = item.mm;
    const isOut = directionFor(mm.kind) === "out";
    const Arrow = isOut ? ArrowUpRight : ArrowDownLeft;
    return (
      <Pressable
        onLongPress={canManage && !mm.voidedAt ? () => onVoid(mm) : undefined}
        style={styles.row}
        accessibilityRole="button"
      >
        <View style={styles.rowIcon}>
          <Arrow size={18} color={isOut ? colors.danger : colors.success} weight="bold" />
        </View>
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {t(`mobile.financials.moneyMovements.kinds.${mm.kind}`)}
          </Text>
          <Text style={styles.rowMeta}>
            {shortDate(mm.occurredAt)}
            {mm.paymentMethod
              ? ` · ${t(`app.activityLabels.paymentMethods.${mm.paymentMethod}` as never)}`
              : ""}
            {mm.description ? ` · ${mm.description}` : ""}
          </Text>
        </View>
        <View style={styles.rowRight}>
          <Text
            style={[
              styles.rowAmount,
              { color: isOut ? colors.danger : colors.success },
            ]}
          >
            {isOut ? "− " : "+ "}
            {money(mm.amount)}
          </Text>
          {mm.voidedAt ? (
            <Badge
              label={t("mobile.financials.moneyMovements.voidedBadge")}
              variant="outofstock"
            />
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1 }}>
    <Screen title={t("mobile.financials.moneyMovements.title")}>
      <Card>
        <Text style={styles.disclaimer}>
          {t("mobile.financials.moneyMovements.notPnlNote")}
        </Text>
        <View style={styles.totalsRow}>
          <View style={styles.totalCell}>
            <Text style={styles.totalLabel}>
              {t("mobile.financials.moneyMovements.totalsIn")}
            </Text>
            <Text style={[styles.totalValue, { color: colors.success }]}>
              {money(totals.moneyIn)}
            </Text>
          </View>
          <View style={styles.totalCell}>
            <Text style={styles.totalLabel}>
              {t("mobile.financials.moneyMovements.totalsOut")}
            </Text>
            <Text style={[styles.totalValue, { color: colors.danger }]}>
              {money(totals.moneyOut)}
            </Text>
          </View>
        </View>
      </Card>

      <PresetChips value={range} onChange={setRange} />

      <View style={styles.topRow}>
        <Pressable
          onPress={filter.open}
          style={styles.filterBtn}
          accessibilityRole="button"
        >
          <Funnel size={16} color={colors.accent} weight="bold" />
          <Text style={styles.filterText}>
            {kindFilter
              ? t(`mobile.financials.moneyMovements.kinds.${kindFilter}`)
              : t("mobile.financials.moneyMovements.kindAll")}
            {status !== "active" ? ` · ${t(`mobile.financials.moneyMovements.status${capitalize(status)}` as never)}` : ""}
          </Text>
        </Pressable>
      </View>

      <View style={styles.listWrap}>
        {q.isPending && !q.data ? (
          <SkeletonListRow count={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("mobile.financials.moneyMovements.listEmpty")}
            hint={t("mobile.financials.moneyMovements.listEmptyHint")}
          />
        ) : (
          <FlashList
            data={rows}
            renderItem={renderItem}
            keyExtractor={(item, i) =>
              item.kind === "footer-loading" ? `f-${i}` : item.mm.id
            }
            onEndReachedThreshold={0.6}
            onEndReached={() => {
              if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
            }}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
          />
        )}
      </View>

      <MoneyMovementFormSheet visible={form.visible} onClose={form.close} />

      <MoneyMovementFilterSheet
        visible={filter.visible}
        onClose={filter.close}
        kind={kindFilter}
        onKindChange={setKindFilter}
        status={status}
        onStatusChange={setStatus}
      />
    </Screen>

    {canManage ? (
      <Pressable
        onPress={form.open}
        style={styles.fab}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.financials.moneyMovements.newTitle")}
      >
        <Plus size={22} color={colors.card} weight="bold" />
      </Pressable>
    ) : null}
    </View>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function MoneyMovementFilterSheet({
  visible,
  onClose,
  kind,
  onKindChange,
  status,
  onStatusChange,
}: {
  visible: boolean;
  onClose: () => void;
  kind: MoneyMovementKind | undefined;
  onKindChange: (v: MoneyMovementKind | undefined) => void;
  status: "active" | "voided" | "any";
  onStatusChange: (v: "active" | "voided" | "any") => void;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile.financials.moneyMovements.filterTitle")}
      testID="mm-filter"
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose }}
    >
      <Text style={styles.label}>
        {t("mobile.financials.moneyMovements.fieldKind")}
      </Text>
      <View style={styles.chipRow}>
        <Pressable
          onPress={() => onKindChange(undefined)}
          style={[styles.chip, kind === undefined && styles.chipActive]}
        >
          <Text style={[styles.chipText, kind === undefined && styles.chipTextActive]}>
            {t("mobile.financials.moneyMovements.kindAll")}
          </Text>
        </Pressable>
        {MONEY_MOVEMENT_KINDS.map((k) => (
          <Pressable
            key={k}
            onPress={() => onKindChange(k)}
            style={[styles.chip, kind === k && styles.chipActive]}
          >
            <Text style={[styles.chipText, kind === k && styles.chipTextActive]}>
              {t(`mobile.financials.moneyMovements.kinds.${k}`)}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.label, { marginTop: spacing.md }]}>
        {t("mobile.financials.moneyMovements.statusAll")}
      </Text>
      <View style={styles.chipRow}>
        {(["active", "voided", "any"] as const).map((s) => (
          <Pressable
            key={s}
            onPress={() => onStatusChange(s)}
            style={[styles.chip, status === s && styles.chipActive]}
          >
            <Text style={[styles.chipText, status === s && styles.chipTextActive]}>
              {t(`mobile.financials.moneyMovements.status${capitalize(s)}` as never)}
            </Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  err: { ...RTL_TEXT, fontSize: 14, color: colors.danger },
  disclaimer: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  totalsRow: { flexDirection: "row", gap: spacing.md },
  totalCell: { flex: 1 },
  totalLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
  },
  totalValue: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    fontVariant: ["tabular-nums"],
    marginTop: 2,
  },
  topRow: { flexDirection: "row" },
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  filterText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.accent,
  },
  listWrap: { minHeight: 300 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  rowMain: { flex: 1 },
  rowTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
  rowMeta: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  rowRight: { alignItems: "flex-end", gap: 4 },
  rowAmount: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    fontVariant: ["tabular-nums"],
  },
  sep: { height: spacing.xs },
  fab: {
    position: "absolute",
    end: spacing.lg,
    bottom: spacing.xl + 40,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    ...elevation.modal,
  },
  label: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  chipTextActive: { color: colors.card },
});
