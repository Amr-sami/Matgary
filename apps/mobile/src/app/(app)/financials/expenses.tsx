// /financials/expenses — mobile Expenses CRUD.
//
// Reuses the web backend: `/api/financials/expenses` (GET/POST),
// `/api/financials/expenses/[id]` (PATCH), `/api/financials/expenses/[id]/void`
// (POST). No new API routes — mobile is a client of the same engine.
//
// Pattern: FlashList (infinite scroll) + pull-to-refresh + top filter row +
// floating "+" button that opens the shared ExpenseFormSheet. Row tap opens
// the same sheet in edit mode. Void lives inside the sheet.

import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useLocalSearchParams, useRouter } from "expo-router";
import { FunnelIcon as Funnel } from "phosphor-react-native/src/icons/Funnel";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";

import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import {
  SkeletonListRow,
  SkeletonPaginationFooter,
} from "@/components/ui/skeleton";
import { PresetChips } from "@/components/financials/PresetChips";
import { ExpenseFormSheet } from "@/components/financials/ExpenseFormSheet";
import { ExpensesFilterSheet } from "@/components/financials/ExpensesFilterSheet";
import { Sheet, useSheet } from "@/components/ui/Sheet";
import {
  useFinanceCategories,
  useFinanceExpenses,
  type FinanceExpenseListItem,
  type FinanceExpensesListFilters,
  type FinancialsRange,
} from "@/hooks/useFinance";
import { useSession } from "@/stores/session";
import { useDebounced } from "@/lib/useDebounced";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

type Row =
  | { kind: "row"; expense: FinanceExpenseListItem }
  | { kind: "footer-loading" };

export default function ExpensesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ templateOnly?: string }>();
  const templateOnly = params.templateOnly === "1";

  const [range, setRange] = useState<FinancialsRange>({ preset: "this_month" });
  const [status, setStatus] = useState<"posted" | "voided" | "any">("posted");
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [paymentMethod, setPaymentMethod] = useState<string | undefined>(undefined);
  const [searchDraft, setSearchDraft] = useState("");
  const search = useDebounced(searchDraft, 300);
  const [editTarget, setEditTarget] = useState<FinanceExpenseListItem | null>(null);

  const me = useSession((s) => s.me);
  const perms = new Set(me?.permissions ?? []);
  const canManage = me?.isOwner || perms.has("manage_expenses");

  const form = useSheet();
  const filter = useSheet();
  const categoriesQ = useFinanceCategories();

  const filters: FinanceExpensesListFilters = useMemo(
    () => ({
      from: range.preset === "custom" ? range.from : undefined,
      to: range.preset === "custom" ? range.to : undefined,
      status,
      categoryId,
      paymentMethod,
      search: search.trim() || undefined,
      isRecurringTemplate: templateOnly ? true : undefined,
      limit: 30,
    }),
    [range, status, categoryId, paymentMethod, search, templateOnly],
  );

  // The list endpoint supports preset-less date filtering; push preset →
  // from/to resolution to the server via the same path when preset is not
  // "custom". For simplicity use the from/to directly when custom; otherwise
  // let the server's default (recent) apply, and the preset chips drive the
  // Overview/P&L screens instead.
  // (The /api/financials/expenses route accepts from/to + no preset.)

  const q = useFinanceExpenses(filters);

  const rows: Row[] = useMemo(() => {
    const all: Row[] = (q.data?.pages ?? []).flatMap((p) =>
      p.data.map((e) => ({ kind: "row" as const, expense: e })),
    );
    if (q.isFetchingNextPage) all.push({ kind: "footer-loading" });
    return all;
  }, [q.data, q.isFetchingNextPage]);

  const activeFilterCount =
    (status !== "posted" ? 1 : 0) +
    (categoryId ? 1 : 0) +
    (paymentMethod ? 1 : 0);

  if (!canManage) {
    return (
      <Screen
        title={templateOnly
          ? t("mobile.financials.recurring.title")
          : t("mobile.financials.expenses.title")}
      >
        <Card>
          <Text style={styles.err}>{t("mobile.financials.expenses.noPermission")}</Text>
        </Card>
      </Screen>
    );
  }

  const renderItem: ListRenderItem<Row> = ({ item }) => {
    if (item.kind === "footer-loading") {
      return <SkeletonPaginationFooter />;
    }
    const e = item.expense;
    return (
      <Pressable
        onPress={() => {
          setEditTarget(e);
          form.open();
        }}
        style={styles.row}
        accessibilityRole="button"
      >
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {e.title}
          </Text>
          <Text style={styles.rowMeta}>
            {(e.categoryNameAr || e.categoryNameEn || "—")}
            {" · "}
            {shortDate(e.date)}
            {e.paymentMethod ? ` · ${t(`app.activityLabels.paymentMethods.${e.paymentMethod}` as never)}` : ""}
          </Text>
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.rowAmount}>{money(e.amount)}</Text>
          {e.status === "voided" ? (
            <Badge label={t("mobile.financials.expenses.voidedBadge")} variant="outofstock" />
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1 }}>
    <Screen
      title={templateOnly
        ? t("mobile.financials.recurring.title")
        : t("mobile.financials.expenses.title")}
    >
      {!templateOnly ? (
        <PresetChips value={range} onChange={setRange} />
      ) : null}

      <View style={styles.topRow}>
        <View style={{ flex: 1 }}>
          <SearchField
            value={searchDraft}
            onChangeText={setSearchDraft}
            placeholder={t("mobile.financials.expenses.searchPlaceholder")}
          />
        </View>
        <Pressable
          onPress={filter.open}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.financials.expenses.filterTitle")}
        >
          <Funnel size={20} color={colors.accent} weight="bold" />
          {activeFilterCount > 0 ? (
            <View style={styles.badgeDot}>
              <Text style={styles.badgeDotText}>{activeFilterCount}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      <View style={styles.listWrap}>
        {q.isPending && !q.data ? (
          <SkeletonListRow count={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("mobile.financials.expenses.listEmpty")}
            hint={t("mobile.financials.expenses.listEmptyHint")}
          />
        ) : (
          <FlashList
            data={rows}
            renderItem={renderItem}
            keyExtractor={(item, i) =>
              item.kind === "footer-loading" ? `f-${i}` : item.expense.id
            }
            onEndReachedThreshold={0.6}
            onEndReached={() => {
              if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
            }}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
          />
        )}
      </View>

      <ExpenseFormSheet
        visible={form.visible}
        onClose={() => {
          form.close();
          setEditTarget(null);
        }}
        expense={editTarget}
        categories={categoriesQ.data ?? []}
      />

      <ExpensesFilterSheet
        visible={filter.visible}
        onClose={filter.close}
        status={status}
        onStatusChange={setStatus}
        categoryId={categoryId}
        onCategoryIdChange={setCategoryId}
        paymentMethod={paymentMethod}
        onPaymentMethodChange={setPaymentMethod}
        categories={categoriesQ.data ?? []}
      />
    </Screen>

    {/* FAB is a SIBLING of Screen so it doesn't scroll with the ScrollView
        inside Screen. Positioned absolute relative to the flex-1 root View,
        which matches the device viewport. */}
    <Pressable
      onPress={() => {
        setEditTarget(null);
        form.open();
      }}
      style={styles.fab}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.financials.expenses.newTitle")}
    >
      <Plus size={22} color={colors.card} weight="bold" />
    </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  err: { ...RTL_TEXT, fontSize: 14, color: colors.danger },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeDot: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  badgeDotText: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    color: colors.card,
  },
  listWrap: {
    minHeight: 300,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowMain: { flex: 1, paddingEnd: spacing.md },
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
    color: colors.text,
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
});
