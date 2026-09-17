import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/** Measured pairs from doc 03 §2: عاجلة on danger-light, عادية on accent-light. */
const PRIORITY: Record<string, { label: string; variant: "outofstock" | "accent" | "neutral" }> = {
  high: { label: "عاجلة", variant: "outofstock" },
  normal: { label: "عادية", variant: "accent" },
  low: { label: "منخفضة", variant: "neutral" },
};

/** Port of app__tasks.png. */
export default function TasksScreen() {
  const q = useQuery({ queryKey: ["tasks"], queryFn: () => catalog.listTasks(api) });

  const rows = q.data ?? [];
  const open = rows.filter((t) => t.status !== "done");
  const done = rows.filter((t) => t.status === "done");

  return (
    <Screen
      title="المهام"
      subtitle={rows.length ? `${open.length} مفتوحة · ${done.length} منجزة` : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState title="لا توجد مهام" />
      ) : (
        <View style={styles.list}>
          {[...open, ...done].map((t) => {
            const p = PRIORITY[t.priority] ?? { label: t.priority, variant: "neutral" as const };
            const isDone = t.status === "done";
            return (
              <View key={t.id} style={[styles.row, isDone && styles.rowDone]}>
                <View style={styles.head}>
                  <Text numberOfLines={2} style={[styles.title, isDone && styles.titleDone]}>
                    {t.title}
                  </Text>
                  <Badge label={p.label} variant={p.variant} />
                </View>
                <View style={styles.meta}>
                  {isDone ? (
                    <Badge label="تم الإنجاز" variant="success" />
                  ) : t.dueDate ? (
                    <Text style={styles.date}>تستحق {shortDate(t.dueDate)}</Text>
                  ) : null}
                </View>
              </View>
            );
          })}
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
  rowDone: { opacity: 0.6 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  title: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  titleDone: { textDecorationLine: "line-through" },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  date: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
});
