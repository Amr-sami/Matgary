import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarIcon as Calendar } from "phosphor-react-native/src/icons/Calendar";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { ApiError } from "@matgary/api-client";

import { api } from "@/api/client";

import { t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { BackLink } from "@/components/ui/BackLink";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DateField } from "@/components/ui/DateField";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { useSession } from "@/stores/session";
import { shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
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
 * `YYYY-MM-DD` from the DateField → a real calendar date (or null). Built at UTC
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
    // "with-branch": team/[userId].tsx caches the bare array under
    // ["leave-requests"]; sharing the key made whichever screen loaded first
    // fix the cached shape for the other (a crash one way, an empty list the
    // other). Prefix-matched invalidations still refresh both.
    queryKey: ["leave-requests", "with-branch"],
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

  return (
    <Screen
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
      // "‹ الفريق" in the FIXED header band — the one BackLink recipe, at the
      // same y as team/attendance and team/[userId] (HeaderAccessories above
      // it on all three). Only whoever can open the Team hub gets the link
      // (the web's tab strip — with its payroll tab that has no native screen
      // — is gone; Team sub-screens share one nav model); staff reach this
      // screen from More and get the plain title.
      header={
        <View style={styles.fixedHeader}>
          <HeaderAccessories />
          {canManageTeam ? (
            <BackLink label={t("mobile.team.back")} onPress={() => router.navigate("/team")} />
          ) : null}
        </View>
      }
    >
      {/* The settings sub-page shape: title + subtitle scroll with the page.
          The subtitle is a mobile key: the web's tabDescriptions.leaves opened
          with "طلبات الإجازة —", an echo of the 26pt title right above it. */}
      <View style={styles.header}>
        <Text style={styles.title}>{t("mobile.leave.title")}</Text>
        <Text style={styles.subtitle}>
          {isManager && pendingCount > 0
            ? t("app.leave.tab.pendingCount", { n: pendingCount })
            : t("mobile.leave.subtitle")}
        </Text>
      </View>

      {canRequest ? (
        // End-aligned like every Screen-level action row (the design's
        // app__leave.png and Activity's "مسح / تطبيق" row).
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
            // Same action as the toolbar button above, so it carries the SAME
            // label: the web's "طلب جديد" here read as a second, different
            // action one card below "طلب إجازة".
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
 * The web's LeaveFormModal. Dates are kept as YYYY-MM-DD (what DateField
 * emits) and sent as ISO datetimes — the server only needs those.
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
    <Sheet
      visible={visible}
      onClose={close}
      title={t("app.leave.form.title")}
      testID="leave-form"
      primaryAction={{
        label: t("app.leave.form.submit"),
        onPress: () => create.mutate(),
        disabled: !datesValid,
        loading: create.isPending,
        testID: "leave-form-submit",
      }}
      secondaryAction={{ label: t("app.leave.form.cancel"), onPress: close }}
    >
      <DateField label={t("mobile.leave.from")} value={start} onChange={setStart} />
      <DateField label={t("mobile.leave.to")} value={end} onChange={setEnd} min={start || undefined} />
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
    </Sheet>
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
    <Sheet
      visible={target !== null}
      onClose={close}
      title={approving ? t("app.leave.tab.decision.approveTitle") : t("app.leave.tab.decision.rejectTitle")}
      testID="leave-decide"
      primaryAction={{
        label: approving ? t("app.leave.tab.decision.approveButton") : t("app.leave.tab.decision.rejectButton"),
        onPress: () => decide.mutate(),
        loading: decide.isPending,
        destructive: !approving,
        testID: "leave-decide-submit",
      }}
      secondaryAction={{ label: t("app.leave.tab.decision.cancel"), onPress: close }}
    >
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
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Same shape as the settings sub-pages and team/attendance: back link, then title, then subtitle.
  fixedHeader: { gap: spacing.xs, alignItems: "flex-start" },
  header: { gap: spacing.xs, alignItems: "flex-start" },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  toolbar: { flexDirection: "row", justifyContent: "flex-end" },
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
  plusBtnLabel: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 16, color: colors.onAccent },
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
  days: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  metaLabel: { ...RTL_TEXT, fontFamily: fonts.medium, color: colors.text },
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
  emptyTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, textAlign: "center" },
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

});
