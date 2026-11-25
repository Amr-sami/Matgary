// Bottom sheet that gates the Expenses list by status / category / payment
// method. "Draft" state inside the sheet so taps feel instant; the parent
// state only updates when the Owner taps Apply. A Reset button clears all
// three in one go.

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Sheet } from "@/components/ui/Sheet";
import { Segmented } from "@/components/ui/Segmented";
import { CategoryPickerSheet } from "@/components/financials/CategoryPickerSheet";
import { useSheet } from "@/components/ui/Sheet";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import type { FinanceCategoryNode } from "@/hooks/useFinance";

interface Props {
  visible: boolean;
  onClose: () => void;
  status: "posted" | "voided" | "any";
  onStatusChange: (v: "posted" | "voided" | "any") => void;
  categoryId: string | undefined;
  onCategoryIdChange: (v: string | undefined) => void;
  paymentMethod: string | undefined;
  onPaymentMethodChange: (v: string | undefined) => void;
  categories: FinanceCategoryNode[];
}

const PAYMENT_METHODS = ["cash", "instapay", "wallet", "card", "other"] as const;

export function ExpensesFilterSheet({
  visible,
  onClose,
  status,
  onStatusChange,
  categoryId,
  onCategoryIdChange,
  paymentMethod,
  onPaymentMethodChange,
  categories,
}: Props) {
  // Draft state so the sheet feels responsive and the parent list only
  // re-queries once the Owner commits.
  const [draftStatus, setDraftStatus] = useState(status);
  const [draftCategory, setDraftCategory] = useState(categoryId);
  const [draftPayment, setDraftPayment] = useState(paymentMethod);

  // Re-seed when the sheet opens (parent values may have changed via Reset).
  useEffect(() => {
    if (visible) {
      setDraftStatus(status);
      setDraftCategory(categoryId);
      setDraftPayment(paymentMethod);
    }
  }, [visible, status, categoryId, paymentMethod]);

  const picker = useSheet();
  const selectedCategory = categories
    .flatMap((g) => [g, ...g.children])
    .find((c) => c.id === draftCategory);

  const apply = () => {
    onStatusChange(draftStatus);
    onCategoryIdChange(draftCategory);
    onPaymentMethodChange(draftPayment);
    onClose();
  };
  const reset = () => {
    setDraftStatus("posted");
    setDraftCategory(undefined);
    setDraftPayment(undefined);
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile.financials.expenses.filterTitle")}
      testID="expenses-filter"
      primaryAction={{
        label: t("mobile.financials.expenses.filterApply"),
        onPress: apply,
      }}
      secondaryAction={{
        label: t("mobile.financials.expenses.filterReset"),
        onPress: reset,
      }}
    >
      <View style={styles.block}>
        <Text style={styles.label}>
          {t("mobile.financials.expenses.statusAll")}
        </Text>
        <Segmented
          items={[
            { key: "posted", label: t("mobile.financials.expenses.statusPosted") },
            { key: "voided", label: t("mobile.financials.expenses.statusVoided") },
            { key: "any", label: t("mobile.financials.expenses.statusAll") },
          ]}
          value={draftStatus}
          onChange={(v) => setDraftStatus(v as "posted" | "voided" | "any")}
        />
      </View>

      <View style={styles.block}>
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

      <View style={styles.block}>
        <Text style={styles.label}>
          {t("mobile.financials.expenses.fieldPaymentMethod")}
        </Text>
        <View style={styles.chipRow}>
          <Chip
            label={t("mobile.financials.expenses.paymentAll")}
            active={draftPayment === undefined}
            onPress={() => setDraftPayment(undefined)}
          />
          {PAYMENT_METHODS.map((m) => (
            <Chip
              key={m}
              label={t(`app.activityLabels.paymentMethods.${m}` as never)}
              active={draftPayment === m}
              onPress={() => setDraftPayment(m)}
            />
          ))}
        </View>
      </View>

      <CategoryPickerSheet
        visible={picker.visible}
        onClose={picker.close}
        categories={categories}
        selectedId={draftCategory ?? null}
        onSelect={(id) => {
          setDraftCategory(id ?? undefined);
          picker.close();
        }}
      />
    </Sheet>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: spacing.md },
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
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  chipTextActive: { color: colors.card },
});
