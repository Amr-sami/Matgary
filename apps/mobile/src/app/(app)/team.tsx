import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { CalendarBlankIcon as CalendarBlank } from "phosphor-react-native/src/icons/CalendarBlank";
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from "phosphor-react-native/src/icons/ClockCounterClockwise";
import { ApiError, team } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";
import { t } from "@/i18n";

const ROLE = (): Record<string, string> => ({
  owner: t("mobile.common.owner"),
  manager: t("features.team.members.manager.role"),
  staff: t("app.teamAdmin.role.staff"),
  cashier: t("features.team.members.cashier.role"),
});

/**
 * Port of app__team.png — the team list, now the hub of the HR drill-ins
 * (doc 02 §1.1 row 15, SPLIT): each row opens /team/[userId], and the
 * attendance chip opens /team/attendance and the leave chip opens /leave.
 *
 * Gating mirrors app/team/page.tsx: the list, the roster and payroll are all
 * behind `manage_team` (owner-expanded server-side into `me.permissions`).
 * GET /api/team 403s for anyone else, so a non-manager sees the forbidden
 * empty state rather than a spinner that never resolves.
 */
/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

export default function TeamScreen() {
  const router = useRouter();
  const permissions = useSession((s) => s.me?.permissions);
  const canManage = new Set(permissions ?? []).has("manage_team");

  const q = useQuery({
    queryKey: ["team"],
    enabled: canManage,
    queryFn: () => team.listTeam(api),
  });
  const rows = q.data ?? [];

  const errorMessage =
    q.error instanceof ApiError && q.error.kind === "forbidden"
      ? t("mobile.common.forbidden")
      : q.error
        ? t("app.teamAdmin.toast.loadFailed")
        : null;

  return (
    <Screen
      title={canManage ? t("app.team.heading.manager") : t("app.team.heading.staff")}
      subtitle={rows.length ? t(`mobile.team.summary${countForm(rows.length)}`, { n: rows.length }) : undefined}
      onRefresh={canManage ? () => void q.refetch() : undefined}
      refreshing={q.isRefetching}
    >
      {!canManage ? (
        <EmptyState title={t("mobile.common.forbidden")} />
      ) : q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : errorMessage ? (
        <EmptyState title={errorMessage} />
      ) : (
        <View style={styles.list}>
          <Pressable
            testID="team-attendance"
            accessibilityRole="button"
            onPress={() => router.push("/team/attendance")}
            style={({ pressed }) => [styles.attendanceRow, pressed && styles.pressed]}
          >
            <View style={styles.attendanceIcon}>
              <ClockCounterClockwise size={22} color={colors.accent} weight="duotone" />
            </View>
            <View style={styles.body}>
              <Text style={styles.name}>{t("app.team.tabs.attendance")}</Text>
              <Text numberOfLines={2} style={styles.meta}>
                {t("app.team.tabDescriptions.attendance")}
              </Text>
            </View>
            <ChevronForward />
          </Pressable>
          <Pressable
            testID="team-leave"
            accessibilityRole="button"
            onPress={() => router.push("/leave")}
            style={({ pressed }) => [styles.attendanceRow, pressed && styles.pressed]}
          >
            <View style={styles.attendanceIcon}>
              <CalendarBlank size={22} color={colors.accent} weight="duotone" />
            </View>
            <View style={styles.body}>
              <Text style={styles.name}>{t("mobile.leave.title")}</Text>
              <Text numberOfLines={2} style={styles.meta}>
                {t("mobile.leave.subtitle")}
              </Text>
            </View>
            <ChevronForward />
          </Pressable>

          {rows.length === 0 ? (
            <EmptyState
              title={t("app.teamAdmin.list.emptyTitle")}
              hint={t("app.teamAdmin.list.emptyHint")}
            />
          ) : (
            rows.map((m) => {
              // The server expands the owner into every permission but the roster
              // row reports the stored (empty) list, so the count would read
              // "0 permissions" — say "all permissions" instead.
              const isOwner = m.role === "owner";
              return (
                <Pressable
                  key={m.userId}
                  testID="team-member-row"
                  accessibilityRole="button"
                  onPress={() => router.push(`/team/${encodeURIComponent(m.userId)}`)}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                >
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
                      {isOwner
                        ? t("mobile.team.memberMetaOwner", { email: m.loginEmail })
                        : t(`mobile.team.memberMeta${countForm(m.permissions.length)}`, {
                            email: m.loginEmail,
                            n: m.permissions.length,
                          })}
                    </Text>
                    {m.mustChangePassword ? (
                      <View style={styles.mustChange}>
                        <Badge label={t("app.teamAdmin.role.mustChange")} variant="lowstock" />
                      </View>
                    ) : null}
                  </View>
                  <Badge
                    label={ROLE()[m.role] ?? m.role}
                    variant={isOwner ? "accent" : "neutral"}
                  />
                  <ChevronForward />
                </Pressable>
              );
            })
          )}
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
    minHeight: MIN_TOUCH,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...elevation.card,
  },
  attendanceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    backgroundColor: colors.accentLight,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.accentLight,
    padding: spacing.lg,
  },
  attendanceIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  pressed: { opacity: 0.85 },
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
  // lineHeight = the circle's height so the line box IS the circle; Cairo's
  // ascent-heavy box then parks the glyph a few pt low, hence the negative
  // marginTop (م / ي / A checked optically). includeFontPadding is Android.
  initial: {
    fontFamily: fonts.bold,
    fontSize: 18,
    lineHeight: 44,
    textAlign: "center",
    includeFontPadding: false,
    marginTop: -2,
    color: colors.accent,
  },
  initialOwner: { color: colors.card },
  body: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  // Lives under the meta line, inside the flexible body column, so a wide
  // warning pill never squeezes the email out of the row (the trailing column
  // holds only the short role pill).
  mustChange: { marginTop: 4, alignItems: "flex-start" },
});
