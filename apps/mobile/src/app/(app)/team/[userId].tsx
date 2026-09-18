import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarBlankIcon as CalendarBlank } from "phosphor-react-native/src/icons/CalendarBlank";
import { ClockIcon as Clock } from "phosphor-react-native/src/icons/Clock";
import { KeyIcon as Key } from "phosphor-react-native/src/icons/Key";
import { UserMinusIcon as UserMinus } from "phosphor-react-native/src/icons/UserMinus";
import { ApiError, team } from "@matgary/api-client";

import { api } from "@/api/client";
import { getLocale, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { money, shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";

/**
 * /team/[userId] — employee detail (doc 02 §1.1 row 15, §2.8).
 *
 * Header → Details (phone / national ID / address, PATCH) → Permissions
 * (grouped toggles, PATCH) → Account (reset password, remove) → Compensation
 * (owner only, like the web's CompensationEditor) → this month's attendance
 * (GET /api/attendance/monthly) → leave summary (GET /api/leave-requests).
 *
 * There is no GET /api/team/[userId] on the web; the row comes from the list.
 * Reading is behind `manage_team`, like app/team/page.tsx. Editing permissions,
 * resetting a password and removing a member are owner-only, like the web's
 * components/settings/TeamEditor.tsx — doc 02 §2.8: `manage_team` has no
 * self-edit guard on the API, so a manager must not get an editor the web
 * withholds. Managers see the same cards read-only.
 */

type CompensationRow = team.CompensationRow;
type PayType = team.PayType;
type TeamMemberDetail = team.TeamMemberDetail;

const ROLE = (): Record<string, string> => ({
  owner: t("mobile.common.owner"),
  manager: t("features.team.members.manager.role"),
  staff: t("app.teamAdmin.role.staff"),
  cashier: t("features.team.members.cashier.role"),
});

// Mirrors apps/web/lib/permissions.ts PERMISSION_GROUPS + the i18n group keys
// in usePermissionCopy.ts. The web's editor omits manage_digest_settings from
// its groups entirely; it is listed here under its own heading so a manager
// can actually grant it from the phone.
const PERMISSION_GROUPS = (): { title: string; permissions: string[] }[] => [
  {
    title: t("app.permissions.groups.pages"),
    permissions: [
      "view_dashboard",
      "view_inventory",
      "view_sales",
      "view_customers",
      "view_expenses",
      "view_returns",
      "view_insights",
      "view_settings",
      "view_suppliers",
      "view_purchases",
    ],
  },
  {
    title: t("app.permissions.groups.edit"),
    permissions: [
      "manage_inventory",
      "record_sales",
      "modify_sales",
      "manage_returns",
      "manage_expenses",
      "manage_catalog",
      "manage_whatsapp",
    ],
  },
  {
    title: t("app.permissions.groups.suppliersPurchases"),
    permissions: ["manage_suppliers", "manage_purchases"],
  },
  {
    title: t("app.permissions.groups.tasksLeaves"),
    permissions: ["manage_tasks", "request_leave", "manage_leave"],
  },
  { title: t("app.permissions.groups.audit"), permissions: ["view_activity_log"] },
  { title: t("app.permissions.groups.attendance"), permissions: ["attendance_self_manual"] },
  { title: t("app.digestSettings.title"), permissions: ["manage_digest_settings"] },
];

const PAY_TYPES = (): { key: PayType; label: string }[] => [
  { key: "fixed", label: t("app.team.compensation.form.payTypes.fixed") },
  { key: "hourly", label: t("app.team.compensation.form.payTypes.hourly") },
  { key: "hybrid", label: t("app.team.compensation.form.payTypes.hybrid") },
];

function permissionLabel(p: string): string {
  const label = t(`app.permissions.labels.${p}`);
  // t() echoes the path for a missing key — fall back to the raw permission.
  return label.startsWith("app.permissions.labels.") ? p : label;
}

const pad = (n: number) => String(n).padStart(2, "0");

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Same rule as team/attendance.tsx: strict YYYY-MM-DD at local midnight. */
function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3]) ? null : d;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.kind === "forbidden") return t("mobile.common.forbidden");
    if (error.kind === "rateLimited") return t("mobile.common.tooManyAttempts");
    // 409 bodies are written in Arabic on the server (lib/repo/team.ts); echo
    // them only in that locale, otherwise the English UI shows a foreign line.
    if (error.kind === "conflict") {
      return getLocale() === "ar" && error.message ? error.message : t("mobile.common.conflict");
    }
    if (error.message) return error.message;
  }
  return fallback;
}

function compensationSummary(row: CompensationRow): string {
  switch (row.payType) {
    case "fixed":
      return t("app.team.compensation.summary.fixed", { amount: money(row.baseSalaryMonthly ?? 0) });
    case "hourly":
      return t("app.team.compensation.summary.hourly", { amount: money(row.hourlyRate ?? 0) });
    default:
      return t("app.team.compensation.summary.hybrid", {
        base: money(row.baseSalaryMonthly ?? 0),
        hourly: money(row.hourlyRate ?? 0),
      });
  }
}

function hhmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function TeamMemberScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ userId: string | string[] }>();
  const userId = (Array.isArray(params.userId) ? params.userId[0] : params.userId) ?? "";
  const queryClient = useQueryClient();
  const me = useSession((s) => s.me);
  const canManage = new Set(me?.permissions ?? []).has("manage_team");
  const meIsOwner = me?.user.role === "owner";
  const isSelf = me?.user.id === userId;

  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(null), 3500);
    return () => clearTimeout(id);
  }, [banner]);

  // -- data ---------------------------------------------------------------
  const teamQ = useQuery({
    queryKey: ["team"],
    enabled: canManage,
    queryFn: () => team.listTeam(api),
  });
  const member: TeamMemberDetail | null = useMemo(
    () => teamQ.data?.find((m) => m.userId === userId) ?? null,
    [teamQ.data, userId],
  );
  const targetIsOwner = member?.role === "owner";

  const compQ = useQuery({
    queryKey: ["team", userId, "compensation"],
    enabled: canManage && meIsOwner && !!member && !targetIsOwner,
    queryFn: () => team.listCompensation(api, userId),
  });

  const month = currentMonth();
  const monthlyQ = useQuery({
    queryKey: ["attendance", "monthly", month, userId],
    enabled: canManage && !!member && !targetIsOwner,
    queryFn: () => team.monthlyAttendance(api, month, userId),
  });
  const monthlyRow = monthlyQ.data?.employees.find((e) => e.userId === userId) ?? null;

  const leaveQ = useQuery({
    queryKey: ["leave-requests"],
    enabled: canManage && !!member,
    queryFn: async () => {
      try {
        return await team.listLeaveRequests(api);
      } catch (error) {
        // Leave is behind manage_leave / request_leave, not manage_team. A
        // manager without it just sees no leave section — same as the web.
        if (error instanceof ApiError && error.kind === "forbidden") return null;
        throw error;
      }
    },
  });
  const memberLeave = useMemo(
    () =>
      (leaveQ.data ?? [])
        .filter((l) => l.userId === userId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [leaveQ.data, userId],
  );

  // -- permissions --------------------------------------------------------
  const [perms, setPerms] = useState<Set<string> | null>(null);
  const effectivePerms = perms ?? new Set(member?.permissions ?? []);
  const permsDirty =
    perms !== null &&
    (perms.size !== (member?.permissions.length ?? 0) ||
      (member?.permissions ?? []).some((p: string) => !perms.has(p)));

  const invalidateTeam = () => queryClient.invalidateQueries({ queryKey: ["team"] });

  const savePerms = useMutation({
    mutationFn: () => team.updateMember(api, userId, { permissions: [...effectivePerms] }),
    onSuccess: async () => {
      setPerms(null);
      await invalidateTeam();
      setBanner({ kind: "ok", text: t("app.teamAdmin.toast.savePermsSuccess") });
    },
    onError: (e) => setBanner({ kind: "error", text: errorText(e, t("app.teamAdmin.toast.saveFailed")) }),
  });

  // -- details ------------------------------------------------------------
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [address, setAddress] = useState("");
  const openDetails = () => {
    setDisplayName(member?.displayName ?? "");
    setPhone(member?.phone ?? "");
    setNationalId(member?.nationalId ?? "");
    setAddress(member?.address ?? "");
    setDetailsOpen(true);
  };
  const saveDetails = useMutation({
    mutationFn: () =>
      team.updateMember(api, userId, {
        displayName: displayName.trim() || undefined,
        phone: phone.trim() || null,
        nationalId: nationalId.trim() || null,
        address: address.trim() || null,
      }),
    onSuccess: async () => {
      setDetailsOpen(false);
      await invalidateTeam();
      setBanner({ kind: "ok", text: t("mobile.team.detailsSaved") });
    },
    onError: (e) => setBanner({ kind: "error", text: errorText(e, t("app.teamAdmin.toast.saveFailed")) }),
  });

  // -- account ------------------------------------------------------------
  const [pwdOpen, setPwdOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const resetPwd = useMutation({
    mutationFn: () => team.resetPassword(api, userId, newPassword),
    onSuccess: async () => {
      setPwdOpen(false);
      setNewPassword("");
      await invalidateTeam();
      setBanner({ kind: "ok", text: t("mobile.team.passwordSaved") });
    },
    onError: (e) => setBanner({ kind: "error", text: errorText(e, t("app.teamAdmin.toast.resetFailed")) }),
  });

  const remove = useMutation({
    mutationFn: () => team.removeMember(api, userId),
    onSuccess: async () => {
      await invalidateTeam();
      router.navigate("/team");
    },
    onError: (e) => setBanner({ kind: "error", text: errorText(e, t("app.teamAdmin.toast.deleteFailed")) }),
  });
  const confirmRemove = () =>
    Alert.alert(
      t("mobile.team.remove"),
      t("mobile.team.removeConfirm", { name: member?.displayName ?? "" }),
      [
        { text: t("app.team.editEvent.cancel"), style: "cancel" },
        { text: t("app.teamAdmin.row.deleteTitle"), style: "destructive", onPress: () => remove.mutate() },
      ],
    );

  // -- compensation -------------------------------------------------------
  const latestComp = compQ.data?.[0] ?? null;
  const [compOpen, setCompOpen] = useState(false);
  const [payType, setPayType] = useState<PayType>("fixed");
  const [baseSalary, setBaseSalary] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [standardHours, setStandardHours] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const effectiveDate = parseYmd(effectiveFrom);
  const openComp = () => {
    setPayType(latestComp?.payType ?? "fixed");
    setEffectiveFrom(ymd(new Date()));
    setBaseSalary(latestComp?.baseSalaryMonthly != null ? String(latestComp.baseSalaryMonthly) : "");
    setHourlyRate(latestComp?.hourlyRate != null ? String(latestComp.hourlyRate) : "");
    setStandardHours(
      latestComp?.standardMonthlyHours != null ? String(latestComp.standardMonthlyHours) : "",
    );
    setCompOpen(true);
  };
  const num = (s: string): number | null => {
    const n = Number(s.replace(/,/g, "").trim());
    return s.trim() && Number.isFinite(n) ? n : null;
  };
  const saveComp = useMutation({
    mutationFn: () =>
      team.setCompensation(api, userId, {
        payType,
        baseSalaryMonthly: payType === "hourly" ? null : num(baseSalary),
        hourlyRate: payType === "fixed" ? null : num(hourlyRate),
        standardMonthlyHours: payType === "hybrid" ? num(standardHours) : null,
        // Like the web's CompensationEditor the row can be back-dated; the
        // save button is disabled while the date is malformed.
        effectiveFrom: effectiveDate?.toISOString(),
      }),
    onSuccess: async () => {
      setCompOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["team", userId, "compensation"] });
      setBanner({ kind: "ok", text: t("app.team.compensation.toast.saveSuccess") });
    },
    onError: (e) =>
      setBanner({ kind: "error", text: errorText(e, t("app.team.compensation.toast.saveFailed")) }),
  });

  // -- render -------------------------------------------------------------
  const rtl = getLocale() === "ar";
  const busy = savePerms.isPending || saveDetails.isPending || resetPwd.isPending || remove.isPending;

  return (
    <Screen
      onRefresh={() => {
        void teamQ.refetch();
        void compQ.refetch();
        void monthlyQ.refetch();
        void leaveQ.refetch();
      }}
      refreshing={teamQ.isRefetching}
    >
      <Pressable
        accessibilityRole="button"
        testID="team-breadcrumb"
        onPress={() => router.navigate("/team")}
        style={styles.breadcrumb}
      >
        <ChevronBack size={14} color={colors.textSecondary} />
        <Text style={styles.breadcrumbText}>{t("app.team.tabs.team")}</Text>
      </Pressable>

      {banner ? (
        <View style={[styles.banner, banner.kind === "ok" ? styles.bannerOk : styles.bannerError]}>
          <Text style={[styles.bannerText, banner.kind === "ok" ? styles.bannerTextOk : styles.bannerTextError]}>
            {banner.text}
          </Text>
        </View>
      ) : null}

      {!canManage ? (
        <EmptyState title={t("mobile.common.forbidden")} />
      ) : teamQ.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : teamQ.error ? (
        <EmptyState title={errorText(teamQ.error, t("app.teamAdmin.toast.loadFailed"))} />
      ) : !member ? (
        <EmptyState title={t("mobile.team.notFound")} />
      ) : (
        <View style={styles.stack}>
          {/* Header */}
          <View style={styles.header}>
            <View style={[styles.avatar, targetIsOwner && styles.avatarOwner]}>
              <Text style={[styles.initial, targetIsOwner && styles.initialOwner]}>
                {(member.displayName || member.username || "?").trim().charAt(0)}
              </Text>
            </View>
            <Text style={styles.name}>{member.displayName || member.username}</Text>
            <Text style={styles.handle}>{member.loginEmail}</Text>
            <View style={styles.badges}>
              <Badge label={ROLE()[member.role] ?? member.role} variant={targetIsOwner ? "accent" : "neutral"} />
              {member.mustChangePassword ? (
                <Badge label={t("app.teamAdmin.role.mustChange")} variant="lowstock" />
              ) : null}
            </View>
            {member.joinedAt ? (
              <Text style={styles.joined}>
                {t("mobile.team.joinedAt", { date: shortDate(member.joinedAt) })}
              </Text>
            ) : null}
          </View>

          {/* Details */}
          <Card title={t("mobile.team.details")}>
            <InfoRow label={t("mobile.team.phone")} value={member.phone} ltr />
            <InfoRow label={t("mobile.team.nationalId")} value={member.nationalId} ltr />
            <InfoRow label={t("mobile.team.address")} value={member.address} />
            <Button
              label={t("app.teamAdmin.row.editDetailsTitle")}
              variant="outline"
              onPress={openDetails}
              disabled={busy}
              style={styles.cardButton}
            />
          </Card>

          {/* Permissions */}
          <View testID="team-permissions">
          <Card title={t("app.teamAdmin.row.permissions")}>
            {targetIsOwner ? (
              <Text style={styles.hint}>{t("mobile.team.ownerAllPermissions")}</Text>
            ) : (
              <>
                <Text style={styles.hint}>
                  {t("mobile.team.permissionsCount", { n: effectivePerms.size })}
                </Text>
                {!meIsOwner ? (
                  <Text style={styles.hint}>{t("mobile.team.permissionsOwnerOnly")}</Text>
                ) : null}
                {PERMISSION_GROUPS().map((g) => (
                  <View key={g.title} style={styles.group}>
                    <Text style={styles.groupTitle}>{g.title}</Text>
                    {g.permissions.map((p) => (
                      <View key={p} style={styles.toggleRow}>
                        <Text style={styles.toggleLabel}>{permissionLabel(p)}</Text>
                        <Switch
                          value={effectivePerms.has(p)}
                          disabled={busy || isSelf || !meIsOwner}
                          onValueChange={(v) => {
                            const next = new Set(effectivePerms);
                            if (v) next.add(p);
                            else next.delete(p);
                            setPerms(next);
                          }}
                          trackColor={{ true: colors.accent, false: colors.border }}
                        />
                      </View>
                    ))}
                  </View>
                ))}
                {meIsOwner && permsDirty ? (
                  <Button
                    label={t("app.teamAdmin.row.savePermissions")}
                    onPress={() => savePerms.mutate()}
                    loading={savePerms.isPending}
                    disabled={busy}
                    style={styles.cardButton}
                  />
                ) : null}
              </>
            )}
          </Card>
          </View>

          {/* Account — owner only, and never on the owner's own row: the web's
              TeamEditor hides every row action there, and the API answers 409
              to both a reset and a remove of the owner. */}
          {meIsOwner && !targetIsOwner ? (
            <Card title={t("mobile.team.account")}>
              <ActionRow
                icon={<Key size={20} color={colors.accent} />}
                label={t("app.teamAdmin.row.resetPassword")}
                onPress={() => setPwdOpen(true)}
                disabled={busy}
              />
              <ActionRow
                icon={<UserMinus size={20} color={colors.danger} />}
                label={t("mobile.team.remove")}
                danger
                onPress={confirmRemove}
                disabled={busy}
              />
            </Card>
          ) : null}

          {/* Compensation — owner only, like the web */}
          {!targetIsOwner ? (
            <Card title={t("app.team.tabs.payroll")}>
              {!meIsOwner ? (
                <Text style={styles.hint}>{t("app.team.compensation.ownerOnly")}</Text>
              ) : compQ.isLoading ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <>
                  <Text style={styles.valueBig}>
                    {latestComp
                      ? compensationSummary(latestComp)
                      : t("app.team.compensation.noCompensation")}
                  </Text>
                  {latestComp ? (
                    <Text style={styles.hint}>
                      {t("mobile.team.compensationHistory", { date: shortDate(latestComp.effectiveFrom) })}
                    </Text>
                  ) : null}
                  <Button
                    label={t("app.team.compensation.edit")}
                    variant="outline"
                    onPress={openComp}
                    disabled={busy}
                    style={styles.cardButton}
                  />
                </>
              )}
            </Card>
          ) : null}

          {/* Attendance this month */}
          {!targetIsOwner ? (
            <Card title={t("mobile.team.attendanceMonth")}>
              {monthlyQ.isLoading ? (
                <ActivityIndicator color={colors.accent} />
              ) : monthlyQ.error ? (
                <Text style={styles.hint}>{t("app.team.monthly.loadFailed")}</Text>
              ) : !monthlyRow || monthlyRow.shifts.length === 0 ? (
                <Text style={styles.hint}>{t("app.team.monthly.noShifts")}</Text>
              ) : (
                <>
                  <View style={styles.statsRow}>
                    <Stat
                      label={t("mobile.team.hoursTotal")}
                      value={t("mobile.team.hoursShort", { h: monthlyRow.totals.hoursTotal.toFixed(1) })}
                    />
                    <Stat label={t("mobile.team.daysWorked")} value={String(monthlyRow.totals.daysWorked)} />
                    <Stat
                      label={t("app.team.monthly.metric.expected")}
                      value={t("mobile.team.hoursShort", { h: String(monthlyRow.totals.expectedHours) })}
                    />
                  </View>
                  {monthlyRow.totals.reviewCount > 0 ? (
                    <Badge
                      label={t("app.team.roster.pill.review", { n: monthlyRow.totals.reviewCount })}
                      variant="lowstock"
                    />
                  ) : null}
                  {[...monthlyRow.shifts].reverse().slice(0, 7).map((s) => (
                    <View key={`${s.date}-${s.checkInAt}`} style={styles.shiftRow}>
                      <CalendarBlank size={16} color={colors.textSecondary} />
                      <Text style={styles.shiftDate}>{shortDate(s.date)}</Text>
                      <Clock size={16} color={colors.textSecondary} />
                      <Text style={styles.shiftTime}>
                        {hhmm(s.checkInAt)} → {s.checkOutAt ? hhmm(s.checkOutAt) : t("app.team.monthly.table.open")}
                      </Text>
                      <Text style={styles.shiftHours}>
                        {t("mobile.team.hoursShort", { h: s.hours.toFixed(1) })}
                      </Text>
                    </View>
                  ))}
                </>
              )}
            </Card>
          ) : null}

          {/* Leave summary */}
          {leaveQ.data !== null && leaveQ.data !== undefined ? (
            <Card title={t("mobile.team.leaveSummary")}>
              {memberLeave.length === 0 ? (
                <Text style={styles.hint}>{t("mobile.team.noLeave")}</Text>
              ) : (
                <>
                  <View style={styles.statsRow}>
                    {(["pending", "approved", "rejected"] as const).map((s) => (
                      <Stat
                        key={s}
                        label={t(`app.leave.status.${s}`)}
                        value={String(memberLeave.filter((l) => l.status === s).length)}
                      />
                    ))}
                  </View>
                  {memberLeave.slice(0, 5).map((l) => (
                    <View key={l.id} style={styles.shiftRow}>
                      <CalendarBlank size={16} color={colors.textSecondary} />
                      <Text style={[styles.shiftTime, styles.grow]}>
                        {shortDate(l.startDate)} – {shortDate(l.endDate)}
                      </Text>
                      <Badge
                        label={t(`app.leave.status.${l.status}`)}
                        variant={l.status === "approved" ? "success" : l.status === "rejected" ? "outofstock" : "lowstock"}
                      />
                    </View>
                  ))}
                </>
              )}
            </Card>
          ) : null}
        </View>
      )}

      {/* Details modal */}
      <Modal visible={detailsOpen} animationType="slide" onRequestClose={() => setDetailsOpen(false)}>
        <View style={[styles.modal, directionStyle(rtl)]}>
          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t("app.teamAdmin.row.editDetailsTitle")}</Text>
            <Field label={t("app.activityLabels.fieldNames.displayName")} value={displayName} onChangeText={setDisplayName} />
            <Field label={t("mobile.team.phone")} value={phone} onChangeText={setPhone} keyboardType="phone-pad" ltr />
            <Field label={t("mobile.team.nationalId")} value={nationalId} onChangeText={setNationalId} keyboardType="number-pad" ltr />
            <Field label={t("mobile.team.address")} value={address} onChangeText={setAddress} />
            <Button
              label={t("app.team.editEvent.save")}
              onPress={() => saveDetails.mutate()}
              loading={saveDetails.isPending}
              disabled={displayName.trim().length === 0}
            />
            <Button label={t("app.team.editEvent.cancel")} variant="ghost" onPress={() => setDetailsOpen(false)} />
          </ScrollView>
        </View>
      </Modal>

      {/* Reset password modal */}
      <Modal visible={pwdOpen} animationType="slide" onRequestClose={() => setPwdOpen(false)}>
        <View style={[styles.modal, directionStyle(rtl)]}>
          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t("app.teamAdmin.row.resetPassword")}</Text>
            <Text style={styles.hint}>{t("mobile.team.passwordHint")}</Text>
            <Field
              label={t("mobile.team.newPassword")}
              value={newPassword}
              onChangeText={setNewPassword}
              secure
              ltr
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Button
              label={t("app.team.editEvent.save")}
              onPress={() => resetPwd.mutate()}
              loading={resetPwd.isPending}
              disabled={newPassword.length < 8}
            />
            <Button label={t("app.team.editEvent.cancel")} variant="ghost" onPress={() => setPwdOpen(false)} />
          </ScrollView>
        </View>
      </Modal>

      {/* Compensation modal */}
      <Modal visible={compOpen} animationType="slide" onRequestClose={() => setCompOpen(false)}>
        <View style={[styles.modal, directionStyle(rtl)]}>
          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t("app.team.compensation.edit")}</Text>
            <Text style={styles.fieldLabel}>{t("app.team.compensation.form.payType")}</Text>
            <Segmented items={PAY_TYPES()} value={payType} onChange={setPayType} />
            {payType !== "hourly" ? (
              <Field
                label={t("app.team.compensation.form.baseSalary")}
                placeholder={t("app.team.compensation.form.baseSalaryPlaceholder")}
                value={baseSalary}
                onChangeText={setBaseSalary}
                keyboardType="decimal-pad"
                ltr
              />
            ) : null}
            {payType !== "fixed" ? (
              <Field
                label={t("app.team.compensation.form.hourlyRate")}
                placeholder={t("app.team.compensation.form.hourlyRatePlaceholder")}
                value={hourlyRate}
                onChangeText={setHourlyRate}
                keyboardType="decimal-pad"
                ltr
              />
            ) : null}
            {payType === "hybrid" ? (
              <Field
                label={t("app.team.compensation.form.standardHours")}
                placeholder={t("app.team.compensation.form.standardHoursPlaceholder")}
                value={standardHours}
                onChangeText={setStandardHours}
                keyboardType="number-pad"
                ltr
              />
            ) : null}
            <Field
              label={t("app.team.compensation.form.effectiveFrom")}
              placeholder={ymd(new Date())}
              value={effectiveFrom}
              onChangeText={setEffectiveFrom}
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              ltr
            />
            {!effectiveDate ? (
              <Text style={styles.fieldError}>{t("mobile.team.attendance.invalidDate")}</Text>
            ) : null}
            {compQ.data && compQ.data.length > 0 ? (
              <View style={styles.history}>
                <Text style={styles.groupTitle}>{t("app.team.compensation.form.historyHeading")}</Text>
                {compQ.data.slice(0, 5).map((row) => (
                  <View key={row.id} style={styles.historyRow}>
                    <Text style={[styles.shiftTime, styles.grow]}>{compensationSummary(row)}</Text>
                    <Text style={styles.shiftDate}>{shortDate(row.effectiveFrom)}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            <Button
              label={t("app.team.compensation.form.save")}
              onPress={() => saveComp.mutate()}
              loading={saveComp.isPending}
              disabled={
                !effectiveDate ||
                (payType !== "hourly" && !(num(baseSalary) ?? 0)) ||
                (payType !== "fixed" && !(num(hourlyRate) ?? 0))
              }
            />
            <Button label={t("app.team.editEvent.cancel")} variant="ghost" onPress={() => setCompOpen(false)} />
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}

function InfoRow({ label, value, ltr }: { label: string; value: string | null; ltr?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, ltr && styles.ltr]} numberOfLines={2}>
        {value?.trim() ? value : "—"}
      </Text>
    </View>
  );
}

function ActionRow({
  icon,
  label,
  onPress,
  danger,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.actionRow, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {icon}
      <Text style={[styles.actionLabel, danger && styles.actionDanger]}>{label}</Text>
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  breadcrumb: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    marginBottom: spacing.sm,
  },
  breadcrumbText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  banner: {
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  bannerOk: { backgroundColor: colors.successLight },
  bannerError: { backgroundColor: colors.dangerLight },
  bannerText: { fontFamily: fonts.medium, fontSize: 14, ...RTL_TEXT },
  bannerTextOk: { color: colors.successStrong },
  bannerTextError: { color: colors.danger },
  header: {
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    ...elevation.card,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarOwner: { backgroundColor: colors.accent },
  initial: { fontFamily: fonts.bold, fontSize: 26, color: colors.accent },
  initialOwner: { color: colors.card },
  name: { fontFamily: fonts.bold, fontSize: 20, color: colors.text, textAlign: "center" },
  handle: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, writingDirection: "ltr" },
  badges: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap", justifyContent: "center" },
  joined: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  hint: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  valueBig: { fontFamily: fonts.semibold, fontSize: 17, color: colors.text, ...RTL_TEXT },
  cardButton: { marginTop: spacing.md },
  fieldError: { fontFamily: fonts.regular, fontSize: 12, color: colors.danger, ...RTL_TEXT },
  infoRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md, paddingVertical: spacing.xs },
  infoLabel: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  infoValue: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, flexShrink: 1, ...RTL_TEXT },
  ltr: { writingDirection: "ltr" },
  group: { marginTop: spacing.md, gap: spacing.xs },
  groupTitle: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
  },
  toggleLabel: { fontFamily: fonts.regular, fontSize: 15, color: colors.text, flex: 1, ...RTL_TEXT },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    paddingVertical: spacing.xs,
  },
  actionLabel: { fontFamily: fonts.medium, fontSize: 15, color: colors.accent, ...RTL_TEXT },
  actionDanger: { color: colors.danger },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
  statsRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  stat: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
    gap: 2,
  },
  statValue: { fontFamily: fonts.bold, fontSize: 18, color: colors.text, fontVariant: ["tabular-nums"] },
  statLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  shiftRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 36,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.xs,
  },
  shiftDate: { fontFamily: fonts.medium, fontSize: 13, color: colors.text, fontVariant: ["tabular-nums"] },
  shiftTime: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
  shiftHours: { fontFamily: fonts.semibold, fontSize: 13, color: colors.text, marginStart: "auto" },
  grow: { flex: 1 },
  history: { gap: spacing.xs },
  historyRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xs },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalBody: { padding: spacing.xl, paddingTop: spacing.xxl * 1.5, gap: spacing.lg },
  modalTitle: { fontFamily: fonts.bold, fontSize: 20, color: colors.text, ...RTL_TEXT },
  fieldLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
});
