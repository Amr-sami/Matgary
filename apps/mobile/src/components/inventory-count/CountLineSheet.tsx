import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MinusIcon as Minus } from "phosphor-react-native/src/icons/Minus";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";

import { t } from "@/i18n";
import { Sheet } from "@/components/ui/Sheet";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";

/**
 * The one sheet that accepts a physical count for a product.
 *
 * Opened by:
 *   - a scanner decode (`source="scan"`, scanner stays open underneath)
 *   - manual search tap (`source="manual"`)
 *   - a review-list tap (edit path — same sheet, with the current counted
 *     value prefilled; saving re-runs PUT …/lines/[productId])
 *
 * Repeated-scan UX (approved):
 *   - If no counted value yet, prefill `1` (one scan ≈ one unit).
 *   - If the line already has a counted value, prefill it + show a prominent
 *     +1 / -1 tally so the shopkeeper can tap once per subsequent unit.
 *   - Manual entry (typing any number) always wins over the tally.
 *   - One line per product per count — the server UPSERTs on (count_id, product_id).
 */

export interface CountLineSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The product's display name (title of the sheet). */
  productName: string;
  /** SKU/barcode — shown under the name as a sanity cue after a scan. */
  productSku?: string | null;
  /** The baseline (what the system said when the count started). Display only. */
  baselineQty: number;
  /** Previously counted value for this line; null when this is the first count. */
  initialCountedQty: number | null;
  /** `scan` opens the sheet with a quick-tally, `manual` opens with the keypad focused. */
  source: "scan" | "manual";
  saving?: boolean;
  errorText?: string | null;
  onSave: (countedQty: number) => void;
  /** Optional: remove the line entirely (surfaced only when a line already exists). */
  onRemove?: () => void;
  /** Optional out-of-scope banner: when the server returned 409 OUT_OF_SCOPE and
   *  the parent chose to prompt the owner, show a yellow "not in scope — add anyway?" */
  outOfScope?: boolean;
  onAddAnyway?: () => void;
  testID?: string;
}

export function CountLineSheet({
  visible,
  onClose,
  productName,
  productSku,
  baselineQty,
  initialCountedQty,
  source,
  saving,
  errorText,
  onSave,
  onRemove,
  outOfScope,
  onAddAnyway,
  testID,
}: CountLineSheetProps) {
  const [qty, setQty] = useState<number>(initialCountedQty ?? (source === "scan" ? 1 : 0));
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setQty(initialCountedQty ?? (source === "scan" ? 1 : 0));
      if (source === "manual") {
        // Focus on the keypad for immediate typing.
        setTimeout(() => inputRef.current?.focus(), 150);
      }
    }
  }, [visible, initialCountedQty, source]);

  const diff = qty - baselineQty;
  const diffColor =
    diff === 0 ? colors.textSecondary : diff > 0 ? colors.successStrong : colors.danger;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={productName}
      subtitle={productSku ?? undefined}
      testID={testID}
      primaryAction={
        outOfScope
          ? {
              label: t("mobile.inventoryCount.sheet.addAnyway"),
              onPress: () => onAddAnyway?.(),
              loading: saving,
              testID: "count-sheet-add-anyway",
            }
          : {
              label: initialCountedQty == null
                ? t("mobile.inventoryCount.sheet.save")
                : t("mobile.inventoryCount.sheet.update"),
              onPress: () => onSave(qty),
              loading: saving,
              disabled: !Number.isFinite(qty) || qty < 0,
              testID: "count-sheet-save",
            }
      }
      secondaryAction={{
        label: t("mobile.inventoryCount.sheet.cancel"),
        onPress: onClose,
      }}
    >
      {outOfScope ? (
        <View style={styles.oosBanner}>
          <Text style={styles.oosText}>
            {t("mobile.inventoryCount.sheet.outOfScope")}
          </Text>
        </View>
      ) : null}

      {/* System quantity (frozen baseline) */}
      <View style={styles.row}>
        <Text style={styles.label}>{t("mobile.inventoryCount.sheet.systemQty")}</Text>
        <Text style={styles.value}>{baselineQty}</Text>
      </View>

      {/* Counted quantity — tap +/− or type */}
      <View style={styles.counterRow}>
        <Pressable
          style={({ pressed }) => [styles.step, pressed && styles.pressed]}
          onPress={() => setQty(Math.max(0, qty - 1))}
          accessibilityLabel={t("mobile.inventoryCount.sheet.minus")}
          disabled={saving || outOfScope === true}
          testID="count-sheet-minus"
        >
          <Minus size={20} color={colors.text} />
        </Pressable>
        <TextInput
          ref={inputRef}
          value={String(qty)}
          onChangeText={(v) => {
            const n = parseInt(v.replace(/[^0-9]/g, ""), 10);
            setQty(Number.isFinite(n) ? n : 0);
          }}
          keyboardType="number-pad"
          selectTextOnFocus
          editable={!saving && !outOfScope}
          style={styles.qtyInput}
          testID="count-sheet-qty"
        />
        <Pressable
          style={({ pressed }) => [styles.step, styles.stepAccent, pressed && styles.pressed]}
          onPress={() => setQty(qty + 1)}
          accessibilityLabel={t("mobile.inventoryCount.sheet.plus")}
          disabled={saving || outOfScope === true}
          testID="count-sheet-plus"
        >
          <Plus size={20} color={colors.onAccent} />
        </Pressable>
      </View>

      {/* Difference preview */}
      <View style={styles.row}>
        <Text style={styles.label}>{t("mobile.inventoryCount.sheet.difference")}</Text>
        <Text style={[styles.value, { color: diffColor }]}>
          {diff > 0 ? `+${diff}` : String(diff)}
        </Text>
      </View>

      {errorText ? <Text style={styles.error}>{errorText}</Text> : null}

      {initialCountedQty != null && onRemove ? (
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          disabled={saving}
          style={({ pressed }) => [styles.removeRow, pressed && styles.pressed]}
          testID="count-sheet-remove"
        >
          <Text style={styles.removeText}>{t("mobile.inventoryCount.sheet.removeLine")}</Text>
        </Pressable>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  label: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  value: {
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  counterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginVertical: spacing.md,
  },
  step: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepAccent: { backgroundColor: colors.accent, borderColor: colors.accent },
  pressed: { opacity: 0.6 },
  qtyInput: {
    flex: 1,
    height: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    textAlign: "center",
    fontFamily: fonts.bold,
    fontSize: 24,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  oosBanner: {
    padding: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.warningLight,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  oosText: { fontFamily: fonts.medium, fontSize: 13, color: colors.warningStrong, ...RTL_TEXT },
  error: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.danger,
    marginTop: spacing.sm,
    ...RTL_TEXT,
  },
  removeRow: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  removeText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.danger,
  },
});
