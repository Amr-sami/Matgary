// Category picker sheet shared by expense-form + any screen that needs a
// category from the finance tree. Groups are rendered bold and non-tappable;
// subcategories are tappable rows. Archived nodes are filtered out — the
// backend still returns them (for historical join reads) but the Owner
// should not pick them for a new expense.

import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ScrollView } from "react-native";

import { Sheet } from "@/components/ui/Sheet";
import { CheckIcon as Check } from "phosphor-react-native/src/icons/Check";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import type { FinanceCategoryNode } from "@/hooks/useFinance";

interface Props {
  visible: boolean;
  onClose: () => void;
  categories: FinanceCategoryNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Filter the tree by kind (defaults to "opex" — only operating expenses
   *  show up in the expense creation picker). Set to null for all kinds. */
  kind?: FinanceCategoryNode["kind"] | null;
}

export function CategoryPickerSheet({
  visible,
  onClose,
  categories,
  selectedId,
  onSelect,
  kind = "opex",
}: Props) {
  const filtered = useMemo(
    () =>
      categories
        .filter((g) => !g.archivedAt && (kind === null || g.kind === kind))
        .map((g) => ({
          ...g,
          children: g.children.filter((c) => !c.archivedAt),
        })),
    [categories, kind],
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile.financials.expenses.pickCategoryTitle")}
      testID="category-picker"
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose }}
    >
      <ScrollView style={{ maxHeight: 480 }}>
        <Pressable
          onPress={() => onSelect(null)}
          style={[styles.row, selectedId === null && styles.rowSelected]}
          accessibilityRole="button"
        >
          <Text style={styles.rowText}>
            {t("mobile.financials.expenses.categoryAll")}
          </Text>
          {selectedId === null ? <Check size={16} color={colors.accent} /> : null}
        </Pressable>

        {filtered.map((g) => (
          <View key={g.id}>
            <View style={styles.group}>
              <Text style={styles.groupText}>{g.nameAr || g.nameEn}</Text>
            </View>
            {g.children.length === 0 ? (
              // A group with zero children can still be picked — legacy data
              // sometimes attaches directly to the group.
              <Pressable
                onPress={() => onSelect(g.id)}
                style={[styles.row, selectedId === g.id && styles.rowSelected]}
                accessibilityRole="button"
              >
                <Text style={styles.rowText}>{g.nameAr || g.nameEn}</Text>
                {selectedId === g.id ? <Check size={16} color={colors.accent} /> : null}
              </Pressable>
            ) : (
              g.children.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => onSelect(c.id)}
                  style={[styles.row, styles.rowChild, selectedId === c.id && styles.rowSelected]}
                  accessibilityRole="button"
                >
                  <Text style={styles.rowText}>{c.nameAr || c.nameEn}</Text>
                  {selectedId === c.id ? <Check size={16} color={colors.accent} /> : null}
                </Pressable>
              ))
            )}
          </View>
        ))}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  group: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
  },
  groupText: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: colors.textSecondary,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  rowChild: { paddingStart: spacing.xl },
  rowSelected: { backgroundColor: colors.accentLight },
  rowText: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
  },
});
