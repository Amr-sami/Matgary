import { Pressable, StyleSheet, Text, View } from "react-native";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { CalendarBlankIcon as CalendarBlank } from "phosphor-react-native/src/icons/CalendarBlank";
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from "phosphor-react-native/src/icons/ClockCounterClockwise";
import { CurrencyDollarSimpleIcon as CurrencyDollarSimple } from "phosphor-react-native/src/icons/CurrencyDollarSimple";
import { UserPlusIcon as UserPlus } from "phosphor-react-native/src/icons/UserPlus";
import { ApiError, team } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";
import { t } from "@/i18n";

const ROLE = (): Record<string, string> => ({
  owner: t("mobile.common.owner"),
  manager: t("features.team.members.manager.role"),
  staff: t("app.teamAdmin.role.staff"),
  cashier: t("features.team.members.cashier.role"),
});

/**
 * Port of app__team.png — the team hub (doc 02 §1.1 row 15, SPLIT).
 *
 * Rows share the one list pattern used elsewhere in the app (see
 * app/(app)/more.tsx): white card, hairline border, plain icon on the start,
 * chevron on the end. No filled chips, no circular icon backgrounds — the
 * detail / attendance / leave drill-ins are visually equal; the member rows
 * underneath use the same frame with initials in a bordered (not filled)
 * circle, so every row on the page shares one silhouette.
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
      ) : q.isPending && !q.data ? (
        <SkeletonListRow count={5} avatarSize={44} trailingWidth={48} height={72} />
      ) : errorMessage ? (
        <EmptyState title={errorMessage} />
      ) : (
        <View style={styles.list}>
          <Pressable
            testID="team-attendance"
            accessibilityRole="button"
            onPress={() => router.push("/team/attendance")}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <ClockCounterClockwise size={22} color={colors.accent} />
            <View style={styles.body}>
              <Text style={styles.name}>{t("app.team.tabs.attendance")}</Text>
              <Text numberOfLines={2} style={styles.meta}>
                {t("app.team.tabDescriptions.attendance")}
              </Text>
            </View>
            <ChevronForward />
          </Pressable>

          <Pressable
            testID="team-payroll"
            accessibilityRole="button"
            onPress={() => router.push("/team/payroll")}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <CurrencyDollarSimple size={22} color={colors.accent} />
            <View style={styles.body}>
              <Text style={styles.name}>{t("mobile.payroll.title")}</Text>
              <Text numberOfLines={2} style={styles.meta}>
                {t("app.team.tabDescriptions.payroll")}
              </Text>
            </View>
            <ChevronForward />
          </Pressable>

          <Pressable
            testID="team-leave"
            accessibilityRole="button"
            onPress={() => router.push("/leave")}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <CalendarBlank size={22} color={colors.accent} />
            <View style={styles.body}>
              <Text style={styles.name}>{t("mobile.leave.title")}</Text>
              <Text numberOfLines={2} style={styles.meta}>
                {t("mobile.leave.subtitle")}
              </Text>
            </View>
            <ChevronForward />
          </Pressable>

          <Pressable
            testID="team-add-member"
            accessibilityRole="button"
            onPress={() => router.push("/team/new")}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <UserPlus size={22} color={colors.accent} />
            <View style={styles.body}>
              <Text style={[styles.name, styles.accentLabel]}>{t("mobile.team.addMember")}</Text>
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
                  <View style={styles.avatar}>
                    <Text style={styles.initial}>
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
  list: { gap: spacing.sm },
  // The one row silhouette for the whole page — matches app/(app)/more.tsx so
  // actions, drill-ins and members all read as the same primitive.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  pressed: { opacity: 0.85 },
  // Initials circle — bordered, not filled: the "no background colour for
  // icons" directive applies here too (an avatar reads as an icon on this
  // page). Text colour carries the identity (accent), not the fill.
  avatar: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  // lineHeight = the circle's height so the line box IS the circle; Cairo's
  // ascent-heavy box then parks the glyph a few pt low, hence the negative
  // marginTop (م / ي / A checked optically). includeFontPadding is Android.
  initial: {
    fontFamily: fonts.bold,
    fontSize: 16,
    lineHeight: 36,
    textAlign: "center",
    includeFontPadding: false,
    marginTop: -2,
    color: colors.accent,
  },
  body: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  // Lift "Add member" by colour only — no filled chip or accent border — so it
  // reads as the primary action without breaking the row silhouette.
  accentLabel: { color: colors.accent },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  mustChange: { marginTop: 4, alignItems: "flex-start" },
});
