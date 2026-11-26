// Date-preset chip row used by every Financials screen. Mirrors the web's
// `components/financials/PresetChips.tsx`, including the "Custom" chip that
// reveals two DateField inputs. Keeping one component means a new preset
// added to the backend lights up everywhere at once.

import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { DateField, type IsoDay } from "@/components/ui/DateField";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import type { FinancialsPreset, FinancialsRange } from "@/hooks/useFinance";

interface PresetChipsProps {
  value: FinancialsRange;
  onChange: (range: FinancialsRange) => void;
  /** Hide the Custom chip where it doesn't apply (e.g. small inline uses). */
  hideCustom?: boolean;
}

const PRESETS: FinancialsPreset[] = [
  "today",
  "yesterday",
  "this_week",
  "this_month",
  "last_month",
  "last_7_days",
  "last_30_days",
  "this_year",
];

export function PresetChips({ value, onChange, hideCustom }: PresetChipsProps) {
  const options: { key: FinancialsPreset; label: string }[] = PRESETS.map((p) => ({
    key: p,
    label: t(`mobile.financials.presets.${p}`),
  }));
  if (!hideCustom) {
    options.push({ key: "custom", label: t("mobile.financials.presets.custom") });
  }

  const [from, setFrom] = useState<IsoDay | null>(value.from ?? null);
  const [to, setTo] = useState<IsoDay | null>(value.to ?? null);

  const commit = (nextFrom: IsoDay | null, nextTo: IsoDay | null) => {
    if (nextFrom && nextTo) {
      onChange({ preset: "custom", from: nextFrom, to: nextTo });
    }
  };

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {options.map((p) => {
          const active = value.preset === p.key;
          return (
            <Pressable
              key={p.key}
              onPress={() => {
                if (p.key === "custom") {
                  // Preserve any already-chosen custom from/to; otherwise
                  // leave the picker in its "waiting for both dates" state.
                  onChange({ preset: "custom", from: from ?? undefined, to: to ?? undefined });
                } else {
                  onChange({ preset: p.key });
                }
              }}
              style={[styles.chip, active && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {p.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {value.preset === "custom" ? (
        <View style={styles.customRow}>
          <View style={{ flex: 1 }}>
            <DateField
              label={t("mobile.financials.customFrom")}
              value={from}
              onChange={(v) => {
                setFrom(v);
                commit(v, to);
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <DateField
              label={t("mobile.financials.customTo")}
              value={to}
              min={from ?? undefined}
              onChange={(v) => {
                setTo(v);
                commit(from, v);
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { gap: spacing.sm, paddingVertical: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  chipTextActive: { color: colors.card },
  customRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
});
