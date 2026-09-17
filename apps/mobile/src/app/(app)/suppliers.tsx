import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/** Port of app__suppliers.png. Balance > 0 means the shop owes the supplier. */
export default function SuppliersScreen() {
  const router = useRouter();
  const q = useQuery({
    queryKey: ["suppliers"],
    queryFn: () => catalog.listSuppliers(api),
  });

  const rows = q.data ?? [];
  const owed = rows.reduce((s, r) => s + Math.max(r.balance, 0), 0);

  return (
    <Screen
      title="الموردون"
      subtitle={rows.length ? `${rows.length} مورد · مستحق ${money(owed)}` : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState title="لا يوجد موردون" />
      ) : (
        <View style={styles.list}>
          {rows.map((s) => (
            <Pressable
              key={s.id}
              accessibilityRole="button"
              accessibilityLabel={`ملف المورد ${s.name}`}
              onPress={() => router.push(`/suppliers/${encodeURIComponent(s.id)}`)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.head}>
                <Text numberOfLines={1} style={styles.name}>
                  {s.name}
                </Text>
                {s.balance > 0 ? (
                  <Badge label={money(s.balance)} variant="outofstock" />
                ) : (
                  <Badge label="لا مستحقات" variant="success" />
                )}
              </View>
              {s.phone ? <Text style={styles.meta}>{s.phone}</Text> : null}
              {s.address ? (
                <Text numberOfLines={1} style={styles.meta}>
                  {s.address}
                </Text>
              ) : null}
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
