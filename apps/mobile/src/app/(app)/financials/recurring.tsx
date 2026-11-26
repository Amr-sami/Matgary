// /financials/recurring — mobile Recurring Expense Templates.
//
// Templates live in the same `expenses` table with `isRecurringTemplate=true`.
// The list shows title + amount + frequency + next-occurrence. A "Generate
// now" button triggers the backend's materializeDueRecurringExpenses, which
// is idempotent via a partial UNIQUE index — safe to tap more than once.

import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { ArrowsClockwiseIcon as ArrowsClockwise } from "phosphor-react-native/src/icons/ArrowsClockwise";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";

import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSheet } from "@/components/ui/Sheet";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { RecurringFormSheet } from "@/components/financials/RecurringFormSheet";
import {
  useFinanceCategories,
  useFinanceExpenses,
  useGenerateRecurring,
  type FinanceExpenseListItem,
} from "@/hooks/useFinance";
import { useSession } from "@/stores/session";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

export default function RecurringScreen() {
  const me = useSession((s) => s.me);
  const perms = new Set(me?.permissions ?? []);
  const canManage = me?.isOwner || perms.has("manage_recurring_expenses");

  const form = useSheet();
  const categoriesQ = useFinanceCategories();
  const generateMut = useGenerateRecurring();

  // Templates = isRecurringTemplate=true, status=posted (active). The
  // list intentionally leaves out voided templates — Owner sees only what
  // Storo will spawn next.
  const q = useFinanceExpenses({
    status: "posted",
    isRecurringTemplate: true,
    limit: 30,
  });

  const rows = useMemo(
    () => (q.data?.pages ?? []).flatMap((p) => p.data),
    [q.data],
  );

  if (!canManage) {
    return (
      <Screen title={t("mobile.financials.recurring.title")}>
        <Card>
          <Text style={styles.err}>{t("mobile.financials.expenses.noPermission")}</Text>
        </Card>
      </Screen>
    );
  }

  const onGenerate = async () => {
    try {
      const res = await generateMut.mutateAsync();
      Alert.alert(
        t("mobile.financials.recurring.generatedToast", { n: String(res.spawned) }),
      );
    } catch {
      Alert.alert(t("mobile.financials.expenses.saveFailed"));
    }
  };

  const renderItem: ListRenderItem<FinanceExpenseListItem> = ({ item }) => {
    return (
      <View style={styles.row}>
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.rowMeta}>
            {(item.categoryNameAr || item.categoryNameEn || "—")}
            {" · "}
            {t("mobile.financials.recurring.fieldNextOccurrence")}:{" "}
            {shortDate(item.date)}
          </Text>
        </View>
        <Text style={styles.rowAmount}>{money(item.amount)}</Text>
      </View>
    );
  };

  return (
    <View style={{ flex: 1 }}>
    <Screen title={t("mobile.financials.recurring.title")}>
      <Button
        label={t("mobile.financials.recurring.generateNow")}
        variant="outline"
        onPress={onGenerate}
        loading={generateMut.isPending}
      />

      <View style={styles.listWrap}>
        {q.isPending && !q.data ? (
          <SkeletonListRow count={4} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("mobile.financials.recurring.listEmpty")}
            hint={t("mobile.financials.recurring.listEmptyHint")}
          />
        ) : (
          <FlashList
            data={rows}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
          />
        )}
      </View>

      <RecurringFormSheet
        visible={form.visible}
        onClose={form.close}
        categories={categoriesQ.data ?? []}
      />
    </Screen>

    <Pressable
      onPress={form.open}
      style={styles.fab}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.financials.recurring.newTitle")}
    >
      <Plus size={22} color={colors.card} weight="bold" />
    </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  err: { ...RTL_TEXT, fontSize: 14, color: colors.danger },
  listWrap: { minHeight: 300 },
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
