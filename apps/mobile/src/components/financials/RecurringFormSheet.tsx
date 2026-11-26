// Create a recurring expense template. Uses the same backend endpoint as a
// regular expense (POST /api/financials/expenses) with
// `isRecurringTemplate: true` + a recurrencePeriod + nextOccurrenceDate.
// The server's recurring-generate job then spawns child expenses on schedule
// with partial-UNIQUE idempotency.

import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { Field } from "@/components/ui/Field";
import { DateField, dateToIsoDay } from "@/components/ui/DateField";
import { Sheet, useSheet } from "@/components/ui/Sheet";
import { CategoryPickerSheet } from "@/components/financials/CategoryPickerSheet";
import {
  useCreateExpense,
  type FinanceCategoryNode,
} from "@/hooks/useFinance";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

type Period = "weekly" | "monthly" | "quarterly" | "yearly";
const PERIODS: Period[] = ["weekly", "monthly", "quarterly", "yearly"];

interface Props {
  visible: boolean;
  onClose: () => void;
  categories: FinanceCategoryNode[];
}

export function RecurringFormSheet({ visible, onClose, categories }: Props) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState<Period>("monthly");
  const [nextDate, setNextDate] = useState(dateToIsoDay(new Date()));
  const [categoryId, setCategoryId] = useState<string | null>(null);

  const createMut = useCreateExpense();
  const picker = useSheet();

  const amountNum = useMemo(() => {
    const latin = amount
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .replace(/,/g, ".");
    const n = Number(latin);
    return Number.isFinite(n) ? n : NaN;
  }, [amount]);

  const canSave =
    title.trim().length > 0 && amountNum > 0 && !!nextDate && !createMut.isPending;

  const selectedCategory = useMemo(
    () =>
      categories
        .flatMap((g) => [g, ...g.children])
        .find((c) => c.id === categoryId) ?? null,
    [categories, categoryId],
  );

  const onSave = async () => {
    if (!canSave) return;
    try {
      await createMut.mutateAsync({
        title: title.trim(),
        amount: amountNum,
        date: nextDate,
        categoryId: categoryId ?? undefined,
        isRecurringTemplate: true,
        recurrencePeriod: period,
        nextOccurrenceDate: nextDate,
      });
      setTitle("");
      setAmount("");
      onClose();
    } catch {
      Alert.alert(t("mobile.financials.expenses.saveFailed"));
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile.financials.recurring.newTitle")}
      testID="recurring-form"
      primaryAction={{
        label: t("mobile.financials.expenses.save"),
        onPress: onSave,
        loading: createMut.isPending,
        disabled: !canSave,
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose }}
    >
      <Field
        label={t("mobile.financials.expenses.fieldTitle")}
        value={title}
        onChangeText={setTitle}
        maxLength={160}
      />
      <Field
        label={t("mobile.financials.expenses.fieldAmount")}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        adornment="EGP"
        ltr
      />

      <View>
        <Text style={styles.label}>
          {t("mobile.financials.recurring.fieldFrequency")}
        </Text>
        <View style={styles.chipRow}>
          {PERIODS.map((p) => (
            <Pressable
              key={p}
              onPress={() => setPeriod(p)}
              style={[styles.chip, period === p && styles.chipActive]}
            >
              <Text style={[styles.chipText, period === p && styles.chipTextActive]}>
                {t(`mobile.financials.recurring.frequency.${p}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <DateField
        label={t("mobile.financials.recurring.fieldNextOccurrence")}
        value={nextDate}
        onChange={setNextDate}
      />

      <View>
        <Text style={styles.label}>
          {t("mobile.financials.expenses.fieldCategory")}
        </Text>
        <Pressable
          onPress={picker.open}
          style={styles.selector}
          accessibilityRole="button"
        >
          <Text
            style={[
              styles.selectorText,
              !selectedCategory && styles.placeholder,
            ]}
          >
            {selectedCategory
              ? selectedCategory.nameAr || selectedCategory.nameEn
              : t("mobile.financials.expenses.categoryAll")}
          </Text>
        </Pressable>
      </View>

      <CategoryPickerSheet
        visible={picker.visible}
        onClose={picker.close}
        categories={categories}
        selectedId={categoryId}
        onSelect={(id) => {
          setCategoryId(id);
          picker.close();
        }}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  label: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  selector: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.card,
  },
  selectorText: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
  },
  placeholder: { color: colors.textSecondary },
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
