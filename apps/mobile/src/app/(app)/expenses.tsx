import { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, catalog } from "@matgary/api-client";

import { api } from "@/api/client";

import { t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * The expense categories, in the web's own order.
 *
 * This is a CLOSED enum on the server (app/api/expenses/route.ts) — a free-text
 * category is a 400 — and these seven keys with these seven labels are exactly
 * what app__expenses.png shows, read from
 * apps/web/dictionaries/ar.json → app.catalog.expenseCategory.
 */
const CATEGORY_ORDER: catalog.ExpenseCategory[] = [
  "rent",
  "salaries",
  "electricity",
  "water",
  "internet",
  "supplier",
  "other",
];

const CATEGORY = (): Record<string, string> => ({
  rent: t("app.catalog.expenseCategory.rent"),
  salaries: t("app.catalog.expenseCategory.salaries"),
  electricity: t("app.catalog.expenseCategory.electricity"),
  water: t("app.catalog.expenseCategory.water"),
  internet: t("app.catalog.expenseCategory.internet"),
  supplier: t("app.catalog.expenseCategory.supplier"),
  other: t("app.catalog.expenseCategory.other"),
});

/**
 * ApiError → one Arabic line.
 *
 * These handlers answer a domain failure with a RAW Arabic string in `error`,
 * which the transport reads into `code` (and `message`) because it only treats
 * `detail` as prose. So: if the code is Arabic it IS the message and is shown
 * verbatim; anything else is a machine code the cashier must never see, and is
 * mapped by kind instead.
 */
function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code && /[؀-ۿ]/.test(error.code)) return error.code;
  switch (error.kind) {
    case "offline":
      return t("mobile.common.offline");
    case "timeout":
      return t("mobile.common.timeout");
    case "forbidden":
      return t("mobile.common.forbidden");
    case "rateLimited":
      return t("mobile.signup.tooMany");
    case "billing":
      return t("mobile.common.subscriptionInactive");
    case "server":
      return t("mobile.common.serverError");
    default:
      return fallback;
  }
}

/** Port of app__expenses.png. */
/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

export default function ExpensesScreen() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["expenses"],
    queryFn: () => catalog.listExpenses(api),
  });

  const [formOpen, setFormOpen] = useState(false);

  const rows = q.data ?? [];
  const total = rows.reduce((s, e) => s + e.amount, 0);

  return (
    <Screen
      title={t("app.expenses.title")}
      subtitle={rows.length ? t(`mobile.expenses.summary${countForm(rows.length)}`, { n: rows.length, total: money(total) }) : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <Button label={t("mobile.expenses.add")} onPress={() => setFormOpen(true)} />

      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("mobile.expenses.empty")} />
      ) : (
        <View style={styles.list}>
          {rows.map((e) => (
            <View key={e.id} style={styles.row}>
              <View style={styles.head}>
                <Text numberOfLines={1} style={styles.name}>
                  {e.title}
                </Text>
                {/* Money never splits from its currency — the defect that
                    started the polish pass lived in this exact table. */}
                <Text numberOfLines={1} style={styles.amount}>
                  {money(e.amount)}
                </Text>
              </View>
              <View style={styles.meta}>
                <Badge label={CATEGORY()[e.category] ?? e.category} variant="neutral" />
                <Text style={styles.date}>{shortDate(e.date)}</Text>
                {e.isRecurring ? <Badge label={t("mobile.common.recurring")} variant="accent" /> : null}
              </View>
            </View>
          ))}
        </View>
      )}

      <ExpenseFormSheet
        visible={formOpen}
        onClose={() => setFormOpen(false)}
        onCreated={() => {
          setFormOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["expenses"] });
        }}
      />
    </Screen>
  );
}

/**
 * The web renders this form inline above the table; on a phone that pushes the
 * record it belongs to off-screen, so it becomes a bottom sheet opened by the
 * button. The CONTENT is the capture's, field for field and label for label.
 */
function ExpenseFormSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<catalog.ExpenseCategory>("other");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const amountValue = Number(amount.trim());
  const amountValid = amount.trim().length > 0 && Number.isFinite(amountValue) && amountValue > 0;
  const canSubmit = title.trim().length > 0 && amountValid;

  const reset = () => {
    setTitle("");
    setAmount("");
    setCategory("other");
    setNote("");
    setError(null);
  };

  const create = useMutation({
    mutationFn: () =>
      catalog.createExpense(api, {
        title: title.trim(),
        amount: amountValue,
        category,
        note: note.trim() ? note.trim() : undefined,
      }),
    onSuccess: () => {
      reset();
      onCreated();
    },
    onError: (err) => setError(errorMessage(err, t("mobile.expenses.saveFailed"))),
  });

  const close = () => {
    if (create.isPending) return;
    setError(null);
    onClose();
  };

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title={t("app.expenses.form.heading")}
      testID="expense-form"
      primaryAction={{
        label: t("app.expenses.form.submit"),
        onPress: () => create.mutate(),
        disabled: !canSubmit,
        loading: create.isPending,
        testID: "expense-form-submit",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: close }}
    >
      <Field
        label={t("app.expenses.form.titleLabel")}
        value={title}
        onChangeText={setTitle}
        placeholder={t("app.expenses.form.titlePlaceholder")}
      />
      <Field
        label={t("app.expenses.form.amountLabel")}
        value={amount}
        onChangeText={setAmount}
        placeholder="0.00"
        keyboardType="decimal-pad"
      />

      <View>
        <Text style={styles.label}>{t("app.expenses.form.categoryLabel")}</Text>
        <View style={styles.grid}>
          {CATEGORY_ORDER.map((key) => (
            // The cell fixes the two-column grid of the capture; the
            // Chip stretches to fill it (a column's default align is
            // stretch), so nothing here re-styles the Chip itself.
            <View key={key} style={styles.gridCell}>
              <Chip
                label={CATEGORY()[key]}
                active={category === key}
                onPress={() => setCategory(key)}
              />
            </View>
          ))}
        </View>
      </View>

      <Field
        label={t("app.expenses.form.noteLabel")}
        value={note}
        onChangeText={setNote}
        placeholder={t("app.expenses.form.notePlaceholder")}
      />

      {error ? (
        <Text numberOfLines={3} style={styles.error}>
          {error}
        </Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
    ...elevation.card,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  amount: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.danger,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  date: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },

  label: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    ...RTL_TEXT,
  },
  // Two columns that fill the row exactly (48% + 48% + gap left the trailing
  // column short of the inputs' edge).
  grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -spacing.xs, rowGap: spacing.sm },
  gridCell: { width: "50%", paddingHorizontal: spacing.xs },
  error: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, ...RTL_TEXT },
});
