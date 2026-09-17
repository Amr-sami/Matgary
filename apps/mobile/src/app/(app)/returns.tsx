import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { EmptyState } from "@/components/ui/EmptyState";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Port of app__returns.png.
 *
 * HANDOFF open item 8: on the web a return is actually TAKEN from an invoice
 * row on /sales, not from here — this page only lists them. Doc 04 marks it
 * RECOMPOSE (scan-first) to fix that. Listing is what the capture shows, so
 * that is what this ports; the scan-to-return flow is phase 2.
 */
export default function ReturnsScreen() {
  const q = useQuery({ queryKey: ["returns"], queryFn: () => catalog.listReturns(api) });

  const rows = q.data ?? [];
  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);

  return (
    <Screen
      title="المرتجعات"
      subtitle={rows.length ? `${rows.length} مرتجع · ${money(total)}` : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="لا توجد مرتجعات"
          hint="المرتجع يُسجَّل من فاتورة البيع في شاشة المبيعات."
        />
      ) : (
        <View style={styles.list}>
          {rows.map((r, i) => (
            <View key={r.id ?? String(i)} style={styles.row}>
              <View style={styles.head}>
                <Text numberOfLines={1} style={styles.name}>
                  {r.productName ?? r.invoiceId ?? "مرتجع"}
                </Text>
                <Text style={styles.amount}>{money(r.amount ?? 0)}</Text>
              </View>
              <Text style={styles.meta}>
                {r.quantity ? `${r.quantity} قطعة · ` : ""}
                {shortDate(r.returnDate)}
              </Text>
              {r.reason ? (
                <Text numberOfLines={2} style={styles.meta}>
                  {r.reason}
                </Text>
              ) : null}
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
    gap: 4,
    ...elevation.card,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  amount: { fontFamily: fonts.bold, fontSize: 15, color: colors.danger, fontVariant: ["tabular-nums"] },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
});
