import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Plus } from "phosphor-react-native";
import { ApiError } from "@matgary/api-client";

import { api } from "@/api/client";
import { getLocale, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { useSession } from "@/stores/session";
import { shortDate } from "@/lib/format";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Port of mobile-fold/app__leave.png — the web's LeaveTab (components/leave/
 * LeaveTab.tsx), which since the /team merge lives under /team?tab=leaves.
 *
 * Two modes, decided by the session's permissions exactly like the web:
 *  - request_leave → own requests + a "request leave" sheet (POST).
 *  - manage_leave  → everyone's requests, pending first, approve/reject
 *                    (POST /decide). Managers can also request for themselves
 *                    when they hold both permissions.
 * Delete (DELETE /api/leave-requests/[id]) follows the web's canDelete rule:
 * the owner of a still-pending request, or any manager.
 * The GET already scopes the list server-side (managers see all, others only
 * their own), so the screen never filters by userId for visibility, and — like
 * the web — shows decided history alongside pending rows with no filter.
 */

type LeaveStatus = "pending" | "approved" | "rejected";

type TeamTab = "team" | "attendance" | "payroll" | "leaves";

interface LeaveRequestDto {
  id: string;
  userId: string;
  userName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: LeaveStatus;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

const STATUS_VARIANT: Record<LeaveStatus, "lowstock" | "success" | "outofstock"> = {
  pending: "lowstock",
  approved: "success",
  rejected: "outofstock",
};

const STATUS_LABEL = (s: LeaveStatus) => t(`app.leave.status.${s}`);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Inclusive day count, same rounding as the web's daysBetween. */
function daysBetween(startIso: string, endIso: string): number {
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(1, Math.round((b - a) / DAY_MS) + 1);
}

/** Same as the web's formatRange: a one-day leave collapses to a single date. */
function formatRange(startIso: string, endIso: string): string {
  const a = shortDate(startIso);
  const b = shortDate(endIso);
  return a === b ? a : `${a}${t("app.leave.range.separator")}${b}`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  // The server's zod/conflict messages are Arabic sentences — surface them.
  if (error.code && /[؀-ۿ]/.test(error.code)) return error.code;
  switch (error.kind) {
    case "offline":
      return t("mobile.common.offline");
    case "timeout":
      return t("mobile.common.timeout");
    case "forbidden":
      return t("mobile.common.forbidden");
    case "server":
      return t("mobile.common.serverError");
    default:
      return fallback;
  }
}

/**
 * `YYYY-MM-DD` typed by hand → a real calendar date (or null). Built at UTC
 * midnight so the POST carries the same instant the web sends
 * (`new Date("YYYY-MM-DD").toISOString()`), not a local-midnight offset.
 */
function parseDay(input: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d;
}

export default function LeaveScreen() {
  const me = useSession((s) => s.me);
  const allowed = new Set(me?.permissions ?? []);
  const isManager = allowed.has("manage_leave");
  const canRequest = allowed.has("request_leave");
  // The web's /team page shows its tab strip only to managers; staff land on
  // the leaves tab alone, under the "الإجازات" heading.
  const canManageTeam = allowed.has("manage_team");
  const myUserId = me?.user.id;
  const router = useRouter();

  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["leave-requests"],
    queryFn: () =>
      api.request<{ data: LeaveRequestDto[]; branchId: string | null }>("/api/leave-requests"),
  });
  const items = q.data?.data ?? [];

  // Same as the web: opening the screen clears leave notifications.
  useEffect(() => {
    if (!q.data) return;
    void api.request("/api/leave-requests/seen", { method: "POST" }).catch(() => undefined);
  }, [q.data]);

  const [formOpen, setFormOpen] = useState(false);
  const [decideTarget, setDecideTarget] = useState<{ item: LeaveRequestDto; status: "approved" | "rejected" } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const pendingCount = useMemo(() => items.filter((i) => i.status === "pending").length, [items]);

  // Pending first, newest first inside each group — what a manager scans for.
  const rows = useMemo(
    () =>
      [...items].sort((a, b) => {
        if (a.status === "pending" && b.status !== "pending") return -1;
        if (b.status === "pending" && a.status !== "pending") return 1;
        return b.createdAt.localeCompare(a.createdAt);
      }),
    [items],
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["leave-requests"] });

  const showFlash = (msg: string) => {
    setActionError(null);
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  };

  const remove = useMutation({
    mutationFn: (id: string) => api.request<{ ok: true }>(`/api/leave-requests/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      showFlash(t("app.leave.tab.toast.deleted"));
      void refresh();
    },
    onError: (err) => setActionError(errorMessage(err, t("app.leave.tab.toast.deleteFailed"))),
  });

  // The web's ConfirmDialog; the native confirm is the platform alert.
  const confirmDelete = (it: LeaveRequestDto) => {
    Alert.alert(t("app.leave.tab.deleteDialog.title"), t("app.leave.tab.deleteDialog.message"), [
      { text: t("app.leave.form.cancel"), style: "cancel" },
      { text: t("app.leave.tab.deleteDialog.confirm"), style: "destructive", onPress: () => remove.mutate(it.id) },
    ]);
  };

  // The web's team tab strip. Team and attendance have native screens;
  // payroll has none (doc 02 §1.1 row 15 drops the CompensationEditor from
  // v1) — compensation lives in each employee's detail, so that tab explains
  // where it went at tap time and offers to open the team list. The hint is
  // an alert rather than inline state: this screen stays mounted under the
  // Tabs navigator, so a flag set here would be painted after the push and
  // linger until the next visit.
  const teamTabs = (): { key: TeamTab; label: string }[] => [
    { key: "team", label: t("app.team.tabs.team") },
    { key: "attendance", label: t("app.team.tabs.attendance") },
    { key: "payroll", label: t("app.team.tabs.payroll") },
    { key: "leaves", label: t("app.team.tabs.leaves") },
  ];
  const onTeamTab = (tab: TeamTab) => {
    switch (tab) {
      case "leaves":
        return;
      case "team":
        router.push("/team");
        return;
      case "attendance":
        router.push("/team/attendance");
        return;
      case "payroll":
        Alert.alert(t("app.team.tabs.payroll"), t("mobile.leave.payrollHint"), [
          { text: t("app.leave.form.cancel"), style: "cancel" },
          { text: t("app.team.tabs.team"), onPress: () => router.push("/team") },
        ]);
        return;
    }
  };

  return (
    <Screen
      title={t(canManageTeam ? "app.team.heading.manager" : "app.team.heading.staff")}
      subtitle={
        isManager && pendingCount > 0
          ? t("app.leave.tab.pendingCount", { n: pendingCount })
          : t("app.team.tabDescriptions.leaves")
      }
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {canManageTeam ? <Segmented items={teamTabs()} value="leaves" onChange={onTeamTab} /> : null}

      {canRequest ? (
        // The web parks this on the end side of a justify-between row whose
        // start slot is the pending badge; that badge lives in the subtitle
        // here, so a lone CTA sits on the leading edge (right in RTL) instead.
        <View style={styles.toolbar}>
          <PlusButton label={t("app.leave.tab.request")} onPress={() => setFormOpen(true)} />
        </View>
      ) : null}

      {flash ? <Text style={styles.flash}>{flash}</Text> : null}
      {actionError ? (
        <Text numberOfLines={3} style={styles.error}>
          {actionError}
        </Text>
      ) : null}

      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : q.isError ? (
        <Text numberOfLines={3} style={styles.error}>
          {errorMessage(q.error, t("mobile.common.serverError"))}
        </Text>
      ) : rows.length === 0 ? (
        <View style={styles.emptyCard}>
          <View style={styles.emptyIcon}>
            <Calendar size={28} color={colors.accent} weight="bold" />
          </View>
          <View style={styles.emptyText}>
            <Text style={styles.emptyTitle}>{t("app.leave.tab.emptyTitle")}</Text>
            <Text style={styles.emptyHint}>
              {isManager ? t("app.leave.tab.emptyManager") : t("app.leave.tab.emptyEmployee")}
            </Text>
          </View>
          {canRequest ? (
            <PlusButton label={t("app.leave.tab.request")} onPress={() => setFormOpen(true)} />
          ) : null}
        </View>
      ) : (
        <View style={styles.list}>
          {rows.map((it) => {
            const isMine = it.userId === myUserId;
            const canDecide = isManager && it.status === "pending";
            const canDelete = (isMine && it.status === "pending") || isManager;
            return (
              <View key={it.id} style={styles.row}>
                <View style={styles.head}>
                  <Badge label={STATUS_LABEL(it.status)} variant={STATUS_VARIANT[it.status]} />
                  {isManager || !isMine ? (
                    <Text numberOfLines={1} style={styles.who}>
                      {it.userName ?? t("app.leave.tab.anonymousEmployee")}
                    </Text>
                  ) : null}
                </View>

                <Text style={styles.range}>
                  {formatRange(it.startDate, it.endDate)}
                  <Text style={styles.days}>
                    {" "}
                    {t("app.leave.tab.daysSuffix", { n: daysBetween(it.startDate, it.endDate) })}
                  </Text>
                </Text>

                {it.reason ? (
                  <Text style={styles.meta}>
                    <Text style={styles.metaLabel}>{t("app.leave.tab.reasonLabel")} </Text>
                    {it.reason}
                  </Text>
                ) : null}

                {it.status !== "pending" && it.decidedAt ? (
                  <Text style={styles.meta}>
                    {t("app.leave.tab.decisionBy", {
                      name: it.decidedByName ?? t("app.leave.tab.anonymousEmployee"),
                      date: shortDate(it.decidedAt),
                    })}
                  </Text>
                ) : null}

                {it.decisionNote ? (
                  <Text style={styles.meta}>
                    <Text style={styles.metaLabel}>{t("app.leave.tab.noteLabel")} </Text>
                    {it.decisionNote}
                  </Text>
                ) : null}

                {canDecide || canDelete ? (
                  <View style={styles.actions}>
                    {canDecide ? (
                      <>
                        <Button
                          label={t("app.leave.tab.approve")}
                          onPress={() => setDecideTarget({ item: it, status: "approved" })}
                          style={styles.actionGrow}
                        />
                        <Button
                          label={t("app.leave.tab.reject")}
                          variant="outline"
                          onPress={() => setDecideTarget({ item: it, status: "rejected" })}
                          style={styles.actionGrow}
                        />
                      </>
                    ) : null}
                    {canDelete ? (
                      <Button
                        label={t("app.leave.tab.deleteDialog.confirm")}
                        variant="ghost"
                        onPress={() => confirmDelete(it)}
                        disabled={remove.isPending}
                        style={canDecide ? styles.actionSmall : styles.actionGrow}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      <LeaveFormSheet
        visible={formOpen}
        onClose={() => setFormOpen(false)}
        onCreated={() => {
          setFormOpen(false);
          showFlash(t("app.leave.tab.toast.submitted"));
          void refresh();
        }}
      />

      <DecideSheet
        target={decideTarget}
        onClose={() => setDecideTarget(null)}
        onDecided={(status) => {
          setDecideTarget(null);
          showFlash(status === "approved" ? t("app.leave.tab.toast.approved") : t("app.leave.tab.toast.rejected"));
          void refresh();
        }}
      />
    </Screen>
  );
}

/**
 * The web's primary button with a leading Plus glyph (the "+ طلب إجازة" CTA).
 * The shared Button has no icon slot, so this mirrors its primary styling —
 * same as the Inventory add-product CTA.
 */
function PlusButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.plusBtn, pressed && styles.plusBtnPressed]}
    >
      <Plus size={18} color={colors.onAccent} weight="bold" />
      <Text numberOfLines={1} style={styles.plusBtnLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The web's LeaveFormModal. Dates are typed as YYYY-MM-DD — the app has no
 * date-picker dependency yet, and the server only needs an ISO datetime.
 *
 * RTL is re-applied on the overlay on purpose: a Modal mounts its own native
 * root outside the root layout's direction.
 */
function LeaveFormSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const [start, setStart] = useState(todayStr);
  const [end, setEnd] = useState(todayStr);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const startDate = parseDay(start);
  const endDate = parseDay(end);
  const datesValid = Boolean(startDate && endDate && endDate.getTime() >= startDate.getTime());

  const reset = () => {
    setStart(todayStr);
    setEnd(todayStr);
    setReason("");
    setError(null);
  };

  const create = useMutation({
    mutationFn: () =>
      api.request<LeaveRequestDto>("/api/leave-requests", {
        method: "POST",
        body: {
          startDate: startDate!.toISOString(),
          endDate: endDate!.toISOString(),
          reason: reason.trim() ? reason.trim() : null,
        },
      }),
    onSuccess: () => {
      reset();
      onCreated();
    },
    onError: (err) => setError(errorMessage(err, t("app.leave.tab.toast.submitFailed"))),
  });

  const close = () => {
    if (create.isPending) return;
    setError(null);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={[styles.overlay, directionStyle(getLocale() === "ar")]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={t("app.common.close")} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
              <Text style={styles.sheetTitle}>{t("app.leave.form.title")}</Text>

              <Field
                label={t("mobile.leave.from")}
                value={start}
                onChangeText={setStart}
                placeholder={t("mobile.leave.datePlaceholder")}
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
              />
              <Field
                label={t("mobile.leave.to")}
                value={end}
                onChangeText={setEnd}
                placeholder={t("mobile.leave.datePlaceholder")}
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
              />
              {!datesValid && (start.trim() || end.trim()) ? (
                <Text style={styles.hint}>{t("mobile.leave.invalidDates")}</Text>
              ) : null}

              <Field
                label={t("app.leave.form.reasonLabel")}
                value={reason}
                onChangeText={setReason}
                placeholder={t("app.leave.form.reasonPlaceholder")}
                multiline
                maxLength={500}
              />

              {error ? (
                <Text numberOfLines={3} style={styles.error}>
                  {error}
                </Text>
              ) : null}

              <View style={styles.actions}>
                <Button
                  label={t("app.leave.form.submit")}
                  onPress={() => create.mutate()}
                  disabled={!datesValid}
                  loading={create.isPending}
                  style={styles.actionGrow}
                />
                <Button
                  label={t("app.leave.form.cancel")}
                  variant="outline"
                  onPress={close}
                  style={styles.actionGrow}
                />
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

/** The web's approve/reject confirm dialog with its optional note. */
function DecideSheet({
  target,
  onClose,
  onDecided,
}: {
  target: { item: LeaveRequestDto; status: "approved" | "rejected" } | null;
  onClose: () => void;
  onDecided: (status: "approved" | "rejected") => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("no target");
      return api.request<{ ok: true }>(`/api/leave-requests/${target.item.id}/decide`, {
        method: "POST",
        body: { status: target.status, note: note.trim() || null },
      });
    },
    onSuccess: () => {
      const status = target?.status ?? "approved";
      setNote("");
      setError(null);
      onDecided(status);
    },
    onError: (err) => setError(errorMessage(err, t("app.leave.tab.toast.saveFailed"))),
  });

  const close = () => {
    if (decide.isPending) return;
    setNote("");
    setError(null);
    onClose();
  };

  const approving = target?.status === "approved";

  return (
    <Modal visible={target !== null} transparent animationType="fade" onRequestClose={close}>
      <View style={[styles.overlay, directionStyle(getLocale() === "ar")]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={t("app.common.close")} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
              <Text style={styles.sheetTitle}>
                {approving ? t("app.leave.tab.decision.approveTitle") : t("app.leave.tab.decision.rejectTitle")}
              </Text>

              {target ? (
                <View>
                  <Text style={styles.who}>
                    {target.item.userName ?? t("app.leave.tab.anonymousEmployee")}
                  </Text>
                  <Text style={styles.range}>
                    {formatRange(target.item.startDate, target.item.endDate)}
                    <Text style={styles.days}>
                      {" "}
                      {t("app.leave.tab.daysSuffix", {
                        n: daysBetween(target.item.startDate, target.item.endDate),
                      })}
                    </Text>
                  </Text>
                  {target.item.reason ? (
                    <Text style={styles.meta}>
                      <Text style={styles.metaLabel}>{t("app.leave.tab.reasonLabel")} </Text>
                      {target.item.reason}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              <Field
                label={t("app.leave.tab.decision.noteOptional")}
                value={note}
                onChangeText={setNote}
                placeholder={t("mobile.leave.decisionNoteHint")}
                multiline
                maxLength={500}
              />

              {error ? (
                <Text numberOfLines={3} style={styles.error}>
                  {error}
                </Text>
              ) : null}

              <View style={styles.actions}>
                <Button
                  label={
                    approving ? t("app.leave.tab.decision.approveButton") : t("app.leave.tab.decision.rejectButton")
                  }
                  variant={approving ? "primary" : "outline"}
                  onPress={() => decide.mutate()}
                  loading={decide.isPending}
                  style={styles.actionGrow}
                />
                <Button
                  label={t("app.leave.tab.decision.cancel")}
                  variant="ghost"
                  onPress={close}
                  style={styles.actionGrow}
                />
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: "row", justifyContent: "flex-start" },
  plusBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: 20,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
  },
  plusBtnPressed: { backgroundColor: colors.accentPressed },
  plusBtnLabel: { fontFamily: fonts.bold, fontSize: 16, color: colors.onAccent },
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
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  who: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  range: { fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  days: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  metaLabel: { fontFamily: fonts.medium, color: colors.text },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  actionGrow: { flex: 1 },
  actionSmall: { minWidth: MIN_TOUCH * 2 },
  emptyCard: {
    alignItems: "center",
    gap: spacing.xl,
    paddingVertical: spacing.xxl * 2,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: { alignItems: "center", gap: spacing.xs },
  emptyTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, textAlign: "center", ...RTL_TEXT },
  emptyHint: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, textAlign: "center" },
  flash: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.successStrong,
    backgroundColor: colors.successLight,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    ...RTL_TEXT,
  },
  error: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, ...RTL_TEXT },
  hint: { fontFamily: fonts.regular, fontSize: 13, color: colors.warningStrong, ...RTL_TEXT },

  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: "90%",
    ...elevation.modal,
  },
  sheetBody: { padding: spacing.xl, gap: spacing.lg },
  sheetTitle: { fontFamily: fonts.bold, fontSize: 18, color: colors.text, ...RTL_TEXT },
});
