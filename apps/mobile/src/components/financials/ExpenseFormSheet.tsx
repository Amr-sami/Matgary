// Create / edit sheet for a single expense. Opens from the list screen's
// FAB and from a row tap. The same component handles both paths so the
// Owner sees one consistent form.
//
// All validation + persistence lives on the server. Mobile only guards
// against obviously invalid input (empty title, non-positive amount) so the
// server doesn't have to reject every paste.

import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { Field } from "@/components/ui/Field";
import { DateField, dateToIsoDay, isoDayToDate } from "@/components/ui/DateField";
import { Sheet, useSheet } from "@/components/ui/Sheet";
import { CategoryPickerSheet } from "@/components/financials/CategoryPickerSheet";
import {
  useCreateExpense,
  useUpdateExpense,
  useVoidExpense,
  type FinanceExpenseListItem,
  type FinanceCategoryNode,
} from "@/hooks/useFinance";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** null → create mode; expense row → edit mode. */
  expense: FinanceExpenseListItem | null;
  categories: FinanceCategoryNode[];
}

const PAYMENT_METHODS = ["cash", "instapay", "wallet", "card", "other"] as const;

export function ExpenseFormSheet({ visible, onClose, expense, categories }: Props) {
  const isEdit = expense !== null;
  const [title, setTitle] = useState(expense?.title ?? "");
  const [amount, setAmount] = useState(expense ? String(expense.amount) : "");
  const [date, setDate] = useState(
    expense?.date ? dateToIsoDay(new Date(expense.date)) : dateToIsoDay(new Date()),
  );
  const [categoryId, setCategoryId] = useState<string | null>(expense?.categoryId ?? null);
  const [paymentMethod, setPaymentMethod] = useState<string | null>(
    expense?.paymentMethod ?? null,
  );
  const [referenceNumber, setReferenceNumber] = useState(expense?.referenceNumber ?? "");
  const [note, setNote] = useState(expense?.note ?? "");

  const createMut = useCreateExpense();
  const updateMut = useUpdateExpense();
  const voidMut = useVoidExpense();
  const categoryPicker = useSheet();

  const amountNum = useMemo(() => {
    // Accept Arabic-Indic digits (٠-٩) and both commas + dots for decimal.
    const latin = amount
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .replace(/,/g, ".");
    const n = Number(latin);
    return Number.isFinite(n) ? n : NaN;
  }, [amount]);

  // categoryId is REQUIRED server-side (zod `z.string().uuid()` on POST and
  // the backend rejects 400 without it). Keep the Save button disabled until
  // the Owner picks one; this used to 400 silently with "couldn't save".
  const canSave =
    title.trim().length > 0 &&
    amountNum > 0 &&
    !!date &&
    !!categoryId &&
    !createMut.isPending &&
    !updateMut.isPending;

  const selectedCategory = useMemo(
    () => findCategory(categories, categoryId),
    [categories, categoryId],
  );

  const onSave = async () => {
    if (!canSave) return;
    // Server's zod accepts "YYYY-MM-DD" via `new Date(v)`, but passing a full
    // ISO datetime avoids any TZ edge-case where the local midnight parses
    // to the previous UTC day. Pin to local noon.
    const isoDate = `${date}T12:00:00.000Z`;
    try {
      if (isEdit) {
        await updateMut.mutateAsync({
          id: expense!.id,
          title: title.trim(),
          amount: amountNum,
          date: isoDate,
          categoryId,
          paymentMethod,
          referenceNumber: referenceNumber.trim() || null,
          note: note.trim() || null,
        });
      } else {
        await createMut.mutateAsync({
          title: title.trim(),
          amount: amountNum,
          date: isoDate,
          categoryId: categoryId ?? undefined,
          paymentMethod: paymentMethod ?? undefined,
          referenceNumber: referenceNumber.trim() || undefined,
          note: note.trim() || undefined,
        });
      }
      onClose();
    } catch (err) {
      // Surface the server's own message when available (e.g.
      // "CATEGORY_NOT_FOUND" or a zod field error) so the Owner knows which
      // field to fix instead of a flat "couldn't save".
      const msg =
        err instanceof Error && err.message ? err.message : "";
      Alert.alert(
        t("mobile.financials.expenses.saveFailed"),
        msg || undefined,
      );
    }
  };

  const onVoid = () => {
    if (!isEdit) return;
    Alert.prompt?.(
      t("mobile.financials.expenses.voidTitle"),
      t("mobile.financials.expenses.voidPrompt"),
      async (reason) => {
        try {
          await voidMut.mutateAsync({ id: expense!.id, reason: reason?.trim() || undefined });
          onClose();
        } catch {
          Alert.alert(t("mobile.financials.expenses.voidFailed"));
        }
      },
      "plain-text",
    );
    // Android fallback (Alert.prompt is iOS-only) — just confirm + void.
    if (!Alert.prompt) {
      Alert.alert(
        t("mobile.financials.expenses.voidTitle"),
        t("mobile.financials.expenses.voidPrompt"),
        [
          { text: t("app.common.cancel"), style: "cancel" },
          {
            text: t("mobile.financials.expenses.voidConfirm"),
            style: "destructive",
            onPress: async () => {
              try {
                await voidMut.mutateAsync({ id: expense!.id });
                onClose();
              } catch {
                Alert.alert(t("mobile.financials.expenses.voidFailed"));
              }
            },
          },
        ],
      );
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={isEdit ? t("mobile.financials.expenses.editTitle") : t("mobile.financials.expenses.newTitle")}
      testID="expense-form"
      primaryAction={{
        label: t("mobile.financials.expenses.save"),
        onPress: onSave,
        loading: createMut.isPending || updateMut.isPending,
        disabled: !canSave,
      }}
      secondaryAction={{
        label: t("app.common.cancel"),
        onPress: onClose,
      }}
    >
      <Field
        label={t("mobile.financials.expenses.fieldTitle")}
        value={title}
        onChangeText={setTitle}
        maxLength={160}
        autoCapitalize="sentences"
      />
      <Field
        label={t("mobile.financials.expenses.fieldAmount")}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        adornment="EGP"
        ltr
      />
      <DateField
        label={t("mobile.financials.expenses.fieldDate")}
        value={date}
        max={dateToIsoDay(new Date())}
        onChange={(v) => setDate(v)}
      />

      {/* Category selector — opens a dedicated sheet because the tree can be
          long and system + tenant categories mix. Required field; the picker's
          border turns red when empty so the Owner knows why Save is disabled. */}
      <View>
        <Text style={styles.label}>
          {t("mobile.financials.expenses.fieldCategory")} *
        </Text>
        <Pressable
          onPress={categoryPicker.open}
          style={[styles.selector, !categoryId && styles.selectorRequired]}
          accessibilityRole="button"
        >
          <Text style={[styles.selectorText, !selectedCategory && styles.placeholder]}>
            {selectedCategory
              ? selectedCategory.nameAr || selectedCategory.nameEn
              : t("mobile.financials.expenses.pickCategoryTitle")}
          </Text>
        </Pressable>
      </View>

      {/* Payment method chips — the enum is small enough to show inline. */}
      <View>
        <Text style={styles.label}>
          {t("mobile.financials.expenses.fieldPaymentMethod")}
        </Text>
        <View style={styles.chipRow}>
          <Pressable
            onPress={() => setPaymentMethod(null)}
            style={[styles.chip, paymentMethod === null && styles.chipActive]}
          >
            <Text style={[styles.chipText, paymentMethod === null && styles.chipTextActive]}>
              {t("mobile.financials.expenses.paymentAll")}
            </Text>
          </Pressable>
          {PAYMENT_METHODS.map((m) => (
            <Pressable
              key={m}
              onPress={() => setPaymentMethod(m)}
              style={[styles.chip, paymentMethod === m && styles.chipActive]}
            >
              <Text style={[styles.chipText, paymentMethod === m && styles.chipTextActive]}>
                {t(`app.activityLabels.paymentMethods.${m}` as never)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Field
        label={t("mobile.financials.expenses.fieldReference")}
        value={referenceNumber}
        onChangeText={setReferenceNumber}
        maxLength={80}
      />
      <Field
        label={t("mobile.financials.expenses.fieldNote")}
        value={note}
        onChangeText={setNote}
        maxLength={500}
        multiline
      />

      {isEdit && expense && expense.status === "posted" ? (
        <Pressable onPress={onVoid} style={styles.voidBtn} accessibilityRole="button">
          <Text style={styles.voidText}>{t("mobile.financials.expenses.voidAction")}</Text>
        </Pressable>
      ) : null}

      <CategoryPickerSheet
        visible={categoryPicker.visible}
        onClose={categoryPicker.close}
        categories={categories}
        selectedId={categoryId}
        onSelect={(id) => {
          setCategoryId(id);
          // Pre-fill title if blank to speed data entry.
          if (!title.trim()) {
            const c = findCategory(categories, id);
            if (c) setTitle(c.nameAr || c.nameEn);
          }
          categoryPicker.close();
        }}
      />
    </Sheet>
  );
}

function findCategory(
  tree: FinanceCategoryNode[],
  id: string | null,
): FinanceCategoryNode | null {
  if (!id) return null;
  for (const n of tree) {
    if (n.id === id) return n;
    for (const c of n.children) if (c.id === id) return c;
  }
  return null;
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
  selectorRequired: { borderColor: colors.dangerLight },
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
  voidBtn: {
    borderWidth: 1,
    borderColor: colors.dangerLight,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  voidText: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.danger,
  },
});
