import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/** The web's expense category keys, in Arabic. */
const CATEGORY: Record<string, string> = {
  salaries: "رواتب",
  rent: "إيجار",
  utilities: "مرافق",
  supplies: "مستلزمات",
  marketing: "تسويق",
  shipping: "شحن",
  other: "أخرى",
};

/** Port of app__expenses.png. */
export default function ExpensesScreen() {
  const q = useQuery({
    queryKey: ["expenses"],
    queryFn: () => catalog.listExpenses(api),
  });

  const rows = q.data ?? [];
  const total = rows.reduce((s, e) => s + e.amount, 0);

  return (
    <Screen
      title="المصاريف"
      subtitle={rows.length ? `${rows.length} مصروف · ${money(total)}` : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState title="لا توجد مصاريف" />
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
                <Badge label={CATEGORY[e.category] ?? e.category} variant="neutral" />
                <Text style={styles.date}>{shortDate(e.date)}</Text>
                {e.isRecurring ? <Badge label="متكرر" variant="accent" /> : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </Screen>
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
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.danger,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  date: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
});
