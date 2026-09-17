import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

const ROLE: Record<string, string> = {
  owner: "مالك",
  manager: "مدير",
  staff: "موظف",
  cashier: "كاشير",
};

/**
 * Port of app__team.png.
 *
 * The avatar is the accent-light circle the web uses — measured (231,230,252)
 * for staff, solid accent for the owner.
 */
export default function TeamScreen() {
  const q = useQuery({ queryKey: ["team"], queryFn: () => catalog.listTeam(api) });
  const rows = q.data ?? [];

  return (
    <Screen
      title="الفريق"
      subtitle={rows.length ? `${rows.length} عضو` : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState title="لا يوجد أعضاء" />
      ) : (
        <View style={styles.list}>
          {rows.map((m) => {
            const isOwner = m.role === "owner";
            return (
              <View key={m.userId} style={styles.row}>
                <View style={[styles.avatar, isOwner && styles.avatarOwner]}>
                  <Text style={[styles.initial, isOwner && styles.initialOwner]}>
                    {(m.displayName || m.username || "?").trim().charAt(0)}
                  </Text>
                </View>
                <View style={styles.body}>
                  <Text numberOfLines={1} style={styles.name}>
                    {m.displayName || m.username}
                  </Text>
                  <Text numberOfLines={1} style={styles.meta}>
                    {m.loginEmail} · {m.permissions.length} صلاحية
                  </Text>
                </View>
                <View style={styles.badges}>
                  <Badge label={ROLE[m.role] ?? m.role} variant={isOwner ? "accent" : "neutral"} />
                  {m.mustChangePassword ? (
                    <Badge label="يجب تغيير كلمة السر" variant="lowstock" />
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
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...elevation.card,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  avatarOwner: { backgroundColor: colors.accent },
  initial: { fontFamily: fonts.bold, fontSize: 18, color: colors.accent },
  initialOwner: { color: "#FFFFFF" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  badges: { gap: 4, alignItems: "flex-start", flexShrink: 0 },
});
