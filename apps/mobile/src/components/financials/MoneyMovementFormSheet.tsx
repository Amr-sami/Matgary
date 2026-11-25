// Create-only sheet for a money movement. Edits of description/payment
// method after the fact are supported server-side but rare — mobile exposes
// create + void, which covers 99% of the operational need. Owners on web can
// still relabel if required.

import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { Field } from "@/components/ui/Field";
import { DateField, dateToIsoDay } from "@/components/ui/DateField";
import { Sheet } from "@/components/ui/Sheet";
import {
  useCreateMoneyMovement,
  MONEY_MOVEMENT_KINDS,
  type MoneyMovementKind,
} from "@/hooks/useFinance";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

const PAYMENT_METHODS = ["cash", "instapay", "wallet", "card", "other"] as const;

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function MoneyMovementFormSheet({ visible, onClose }: Props) {
  const [kind, setKind] = useState<MoneyMovementKind>("owner_deposit");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(dateToIsoDay(new Date()));
  const [description, setDescription] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<string | null>(null);

  const createMut = useCreateMoneyMovement();

  const amountNum = useMemo(() => {
    const latin = amount
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .replace(/,/g, ".");
    const n = Number(latin);
    return Number.isFinite(n) ? n : NaN;
  }, [amount]);

  const canSave =
    amountNum > 0 && !!date && !!kind && !createMut.isPending;

  const onSave = async () => {
    if (!canSave) return;
    try {
      // The DateField gives an ISO day; the server wants an ISO instant.
      // Pin to local noon so TZ offsets don't shift the booking day.
      const occurredAt = `${date}T12:00:00.000Z`;
      await createMut.mutateAsync({
        kind,
        amount: amountNum,
        occurredAt,
        description: description.trim() || undefined,
        paymentMethod: paymentMethod ?? undefined,
      });
      // Reset for the next entry.
      setAmount("");
      setDescription("");
      onClose();
    } catch {
      Alert.alert(t("mobile.financials.moneyMovements.saveFailed"));
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile.financials.moneyMovements.newTitle")}
      testID="money-movement-form"
      primaryAction={{
        label: t("mobile.financials.moneyMovements.save"),
        onPress: onSave,
        loading: createMut.isPending,
        disabled: !canSave,
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose }}
    >
      <View>
        <Text style={styles.label}>
          {t("mobile.financials.moneyMovements.fieldKind")}
        </Text>
        <View style={styles.chipRow}>
          {MONEY_MOVEMENT_KINDS.map((k) => (
            <Pressable
              key={k}
              onPress={() => setKind(k)}
              style={[styles.chip, kind === k && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: kind === k }}
            >
              <Text
                style={[styles.chipText, kind === k && styles.chipTextActive]}
              >
                {t(`mobile.financials.moneyMovements.kinds.${k}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Field
        label={t("mobile.financials.moneyMovements.fieldAmount")}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        adornment="EGP"
        ltr
      />

      <DateField
        label={t("mobile.financials.moneyMovements.fieldDate")}
        value={date}
        max={dateToIsoDay(new Date())}
        onChange={setDate}
      />

      <Field
        label={t("mobile.financials.moneyMovements.fieldDescription")}
        value={description}
        onChangeText={setDescription}
        maxLength={500}
        multiline
      />

      <View>
        <Text style={styles.label}>
          {t("mobile.financials.moneyMovements.fieldPaymentMethod")}
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
