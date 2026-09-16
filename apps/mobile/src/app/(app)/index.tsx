import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { ApiError, dashboard as dashboardApi } from "@matgary/api-client";

import { api, API_BASE_URL } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { useSession } from "@/stores/session";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Phase 1's proof screen.
 *
 * It is deliberately not the real dashboard — that is a phase 4 port. What it
 * has to demonstrate is that the whole native auth plane works end to end:
 * a bearer token was minted and stored in the keychain, /me resolved identity
 * and branch, X-Branch-Id switches branch server-side, and an authenticated
 * data route returns real tenant data to a non-browser client.
 */
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const me = useSession((s) => s.me);
  const signOut = useSession((s) => s.signOut);
  const switchBranch = useSession((s) => s.switchBranch);

  const activeBranchId = me?.branch.id ?? null;

  const { data, error, isLoading, refetch, isRefetching } = useQuery({
    // The branch is part of the key: switching branch must refetch, not serve
    // the previous branch's numbers from cache.
    queryKey: ["dashboard", activeBranchId],
    queryFn: () => dashboardApi.getDashboard(api),
  });

  const money = (value: number) =>
    `${value.toLocaleString("en-US")} ج.م`;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + 40 },
      ]}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
      }
    >
      <Text style={styles.greeting}>أهلاً، {me?.tenant.name ?? "متجرك"}</Text>
      <Text style={styles.caption}>
        {me?.user.name ?? me?.user.email} · {me?.user.role}
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>الفرع الحالي</Text>
        <Text style={styles.branchName}>{me?.branch.name ?? "—"}</Text>

        {me && me.branches.length > 1 ? (
          <View style={styles.branchRow}>
            {me.branches.map((b) => {
              const active = b.id === activeBranchId;
              return (
                <Pressable
                  key={b.id}
                  onPress={() => void switchBranch(b.id)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text
                    numberOfLines={1}
                    style={[styles.chipText, active && styles.chipTextActive]}
                  >
                    {b.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>أرقام اليوم</Text>

        {isLoading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.md }} />
        ) : error ? (
          <Text style={styles.error}>
            {error instanceof ApiError ? error.message : "تعذّر تحميل البيانات"}
          </Text>
        ) : data ? (
          <View style={styles.statGrid}>
            <Stat label="مبيعات اليوم" value={money(data.stats.todayRevenue)} />
            <Stat label="مبيعات الشهر" value={money(data.stats.monthRevenue)} />
            <Stat label="مرتجعات الشهر" value={String(data.stats.monthReturns)} />
            <Stat label="عدد المنتجات" value={String(data.stats.productCount)} />
          </View>
        ) : null}
      </View>

      {data && data.lowStock.items.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            مخزون منخفض ({data.lowStock.outOfStockCount + data.lowStock.lowStockCount})
          </Text>
          {data.lowStock.items.slice(0, 5).map((item) => (
            <View key={item.id} style={styles.stockRow}>
              <Text numberOfLines={1} style={styles.stockName}>
                {item.name}
              </Text>
              <View
                style={[
                  styles.qtyChip,
                  item.quantity === 0 ? styles.qtyChipOut : styles.qtyChipLow,
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.qtyText,
                    item.quantity === 0 ? styles.qtyTextOut : styles.qtyTextLow,
                  ]}
                >
                  {item.quantity === 0 ? "نفذ" : `${item.quantity} قطعة`}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>الصلاحيات الفعّالة</Text>
        <Text style={styles.permCount}>
          {me?.permissions.length ?? 0} صلاحية
          {me?.isOwner ? " (مالك)" : ""}
        </Text>
        <Text style={styles.debug}>{API_BASE_URL}</Text>
      </View>

      <Button label="تسجيل الخروج" variant="outline" onPress={() => void signOut()} />
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
      {/* nowrap + tabular: the web shipped a bug where the amount broke away
          from "ج.م" onto its own line. It must not come back here. */}
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: spacing.lg, gap: spacing.lg },
  greeting: { fontFamily: fonts.bold, fontSize: 24, color: colors.text },
  caption: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: -spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    ...elevation.card,
  },
  cardTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.textSecondary },
  branchName: { fontFamily: fonts.bold, fontSize: 20, color: colors.text },
  branchRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    flexShrink: 0,
  },
  chipActive: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  chipText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  chipTextActive: { color: colors.accent },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.sm },
  stat: { flexBasis: "47%", flexGrow: 1, gap: 2 },
  statLabel: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  statValue: { fontFamily: fonts.bold, fontSize: 20, color: colors.text },
  stockRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  stockName: { flex: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.text },
  qtyChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full, flexShrink: 0 },
  qtyChipOut: { backgroundColor: colors.dangerLight },
  qtyChipLow: { backgroundColor: colors.warningTint },
  qtyText: { fontFamily: fonts.medium, fontSize: 12 },
  qtyTextOut: { color: colors.danger },
  qtyTextLow: { color: colors.warningStrong },
  permCount: { fontFamily: fonts.bold, fontSize: 18, color: colors.text },
  debug: { fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
  error: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger },
});
