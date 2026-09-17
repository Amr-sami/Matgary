import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of app__customers.png.
 *
 * Doc 04 marks this RECOMPOSE — receivables first — and that is exactly what
 * the sort does: anyone with an outstanding balance floats to the top, because
 * "who owes me money" is the question this screen exists to answer.
 *
 * Customers are aggregated from sales; there is no customers table.
 */
export default function CustomersScreen() {
  const router = useRouter();
  const q = useQuery({
    queryKey: ["customers"],
    queryFn: () => catalog.listCustomers(api),
  });

  const rows = [...(q.data ?? [])].sort(
    (a, b) => b.outstanding - a.outstanding || b.totalSpend - a.totalSpend,
  );
  const owed = rows.reduce((s, c) => s + c.outstanding, 0);

  return (
    <Screen
      title={t("app.customers.title")}
      subtitle={rows.length ? t("mobile.customers.summary", { n: rows.length, owed: money(owed) }) : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("mobile.customers.empty")} hint={t("mobile.customers.emptyHint")} />
      ) : (
        <View style={styles.list}>
          {rows.map((c) => (
            // The phone is the route key AND can start with "+", which has to
            // survive the URL — hence encodeURIComponent on the way out and a
            // decode on the way in.
            <Pressable
              key={c.phone}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.customers.profileOf", { name: c.name ?? c.phone })}
              onPress={() =>
                router.push(`/customers/${encodeURIComponent(c.phone)}`)
              }
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.head}>
                <Text numberOfLines={1} style={styles.name}>
                  {c.name ?? c.phone}
                </Text>
                {c.outstanding > 0 ? (
                  <Badge label={t("mobile.customers.owes", { amount: money(c.outstanding) })} variant="outofstock" />
                ) : null}
              </View>
              <Text style={styles.meta}>
                {t("mobile.customers.rowMeta", { phone: c.phone, n: c.invoiceCount, spend: money(c.totalSpend) })}
              </Text>
              <Text style={styles.meta}>{t("mobile.customers.lastPurchase", { date: shortDate(c.lastPurchaseAt) })}</Text>
            </Pressable>
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
    gap: 4,
    ...elevation.card,
  },
  rowPressed: { backgroundColor: colors.accentLight },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
});
