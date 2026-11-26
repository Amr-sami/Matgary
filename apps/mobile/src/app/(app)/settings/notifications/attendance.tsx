import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, notifications, team as teamApi } from "@matgary/api-client";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { PencilSimpleIcon as PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { Sheet } from "@/components/ui/Sheet";
import { ToggleRow } from "@/components/ui/ToggleRow";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Notification Center — attendance late-arrival policy and per-employee
 * shift schedules.
 *
 * Reads and writes /api/attendance/schedules; the attendance-late-sweep cron
 * consumes the same rows every 5 min to decide whether to fire
 * attendance.late. Grace -1 means "inherit tenant default".
 */

type Schedule = notifications.EmployeeSchedule;
type TeamMember = teamApi.TeamMemberDetail;

const SCHEDULES_KEY = ["notification-center", "attendance-schedules"] as const;
const TEAM_KEY = ["team-list"] as const;

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WORKDAY_BITS = DOW_KEYS.map((_, idx) => 1 << idx);
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 15, 30, 45] as const;
const GRACE_OPTIONS = [-1, 0, 5, 10, 15, 30, 60] as const;

const EGYPT_DEFAULT_WORKDAYS = 125; // bits Sun..Thu + Sat (Fri off)
const DEFAULT_SHIFT_START = "09:00:00";
const DEFAULT_SHIFT_END = "17:00:00";

function hh(h: number) {
  return String(h).padStart(2, "0");
}

function parseHHMM(s: string): { h: number; m: number } {
  const parts = s.split(":").map((p) => Number(p));
  return { h: parts[0] ?? 0, m: parts[1] ?? 0 };
}

function formatTime(s: string): string {
  const { h, m } = parseHHMM(s);
  return `${hh(h)}:${String(m).padStart(2, "0")}`;
}

function buildTime(h: number, m: number): string {
  return `${hh(h)}:${String(m).padStart(2, "0")}:00`;
}

function workDaysLabel(mask: number): string {
  const picked = DOW_KEYS.filter((_, idx) => (mask & WORKDAY_BITS[idx]!) !== 0);
  if (picked.length === 0) return t("mobile.notifications.attendance.schedules.inherits");
  return picked.map((k) => t(`mobile.notifications.reports.days.${k}`)).join(" · ");
}

function graceLabel(graceMinutes: number): string {
  if (graceMinutes < 0) return t("mobile.notifications.attendance.editor.graceInherit");
  return t("mobile.notifications.attendance.editor.graceValue", { n: graceMinutes });
}

interface DraftSchedule {
  userId: string;
  userName: string | null;
  shiftStart: string;
  shiftEnd: string;
  workDays: number;
  graceMinutes: number;
  enabled: boolean;
  isNew: boolean;
}

export default function AttendanceSettingsScreen() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [draft, setDraft] = useState<DraftSchedule | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const schedulesQ = useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: () => notifications.listSchedules(api),
    staleTime: 60_000,
  });

  const teamQ = useQuery({
    queryKey: TEAM_KEY,
    queryFn: () => teamApi.listTeam(api),
    staleTime: 60_000,
  });

  const upsertM = useMutation({
    mutationFn: (input: notifications.UpsertScheduleInput) =>
      notifications.upsertSchedule(api, input),
    onSuccess: () => {
      setDraft(null);
      setNotice({ tone: "ok", text: t("mobile.notifications.reports.savedOk") });
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError
          ? err.message
          : t("mobile.notifications.attendance.editor.saveFailed");
      setNotice({ tone: "err", text: msg });
    },
  });

  const deleteM = useMutation({
    mutationFn: (userId: string) => notifications.deleteSchedule(api, userId),
    onSuccess: () => {
      setDraft(null);
      setNotice({ tone: "ok", text: t("mobile.notifications.reports.savedOk") });
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError
          ? err.message
          : t("mobile.notifications.attendance.editor.saveFailed");
      setNotice({ tone: "err", text: msg });
    },
  });

  const schedules = schedulesQ.data?.schedules ?? [];
  const existingUserIds = useMemo(() => new Set(schedules.map((s) => s.userId)), [schedules]);
  const members = teamQ.data ?? [];
  const addableMembers = useMemo(
    () => members.filter((m) => !existingUserIds.has(m.userId) && m.role !== "owner"),
    [members, existingUserIds],
  );

  function openEditor(schedule: Schedule) {
    setDraft({
      userId: schedule.userId,
      userName: schedule.userName,
      shiftStart: schedule.shiftStart,
      shiftEnd: schedule.shiftEnd,
      workDays: schedule.workDays,
      graceMinutes: schedule.graceMinutes,
      enabled: schedule.enabled,
      isNew: false,
    });
  }

  function openNew(member: TeamMember) {
    setPickerOpen(false);
    setDraft({
      userId: member.userId,
      userName: member.displayName || member.username || null,
      shiftStart: DEFAULT_SHIFT_START,
      shiftEnd: DEFAULT_SHIFT_END,
      workDays: EGYPT_DEFAULT_WORKDAYS,
      graceMinutes: -1,
      enabled: true,
      isNew: true,
    });
  }

  function save() {
    if (!draft) return;
    upsertM.mutate({
      userId: draft.userId,
      shiftStart: draft.shiftStart,
      shiftEnd: draft.shiftEnd,
      workDays: draft.workDays,
      graceMinutes: draft.graceMinutes,
      enabled: draft.enabled,
    });
  }

  function remove() {
    if (!draft || draft.isNew) return;
    deleteM.mutate(draft.userId);
  }

  return (
    <Screen
      onRefresh={() => void schedulesQ.refetch()}
      refreshing={schedulesQ.isRefetching}
    >
      <SettingsHeader
        parentLabel={t("mobile.notifications.attendance.back")}
        title={t("mobile.notifications.attendance.title")}
        fallback="/settings/notifications"
      />

      {notice ? (
        <Pressable onPress={() => setNotice(null)}>
          <Text
            style={[
              styles.notice,
              notice.tone === "ok" ? styles.noticeOk : styles.noticeErr,
            ]}
          >
            {notice.text}
          </Text>
        </Pressable>
      ) : null}

      <Card>
        <Text style={styles.sectionTitle}>
          {t("mobile.notifications.attendance.policy.title")}
        </Text>
        <Text style={styles.sectionHint}>
          {t("mobile.notifications.attendance.policy.hint")}
        </Text>
      </Card>

      <View style={styles.schedHeader}>
        <Text style={styles.sectionTitle}>
          {t("mobile.notifications.attendance.schedules.title")}
        </Text>
        <Button
          variant="ghost"
          label={t("mobile.notifications.attendance.schedules.add")}
          icon={Plus}
          disabled={addableMembers.length === 0}
          onPress={() => setPickerOpen(true)}
          testID="attendance-add-schedule"
        />
      </View>

      {schedulesQ.isPending && !schedulesQ.data ? (
        <SkeletonListRow count={3} avatarSize={0} trailingWidth={48} height={72} />
      ) : schedules.length === 0 ? (
        <EmptyState title={t("mobile.notifications.attendance.schedules.empty")} />
      ) : (
        <View style={styles.list}>
          {schedules.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => openEditor(s)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel={s.userName ?? ""}
            >
              <View style={styles.rowBody}>
                <View style={styles.rowTitleRow}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {s.userName ?? "—"}
                  </Text>
                  {!s.enabled ? (
                    <Badge
                      label={t("mobile.notifications.attendance.policy.disabledBadge")}
                    />
                  ) : null}
                </View>
                <Text style={styles.rowMeta}>
                  {formatTime(s.shiftStart)} – {formatTime(s.shiftEnd)}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {workDaysLabel(s.workDays)}
                </Text>
                <Text style={styles.rowMeta}>{graceLabel(s.graceMinutes)}</Text>
              </View>
              <PencilSimple size={18} color={colors.textSecondary} />
            </Pressable>
          ))}
        </View>
      )}

      <Sheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={t("mobile.notifications.attendance.schedules.add")}
      >
        <View style={styles.pickerList}>
          {addableMembers.length === 0 ? (
            <Text style={styles.sectionHint}>
              {t("mobile.notifications.attendance.schedules.empty")}
            </Text>
          ) : (
            addableMembers.map((m) => (
              <Pressable
                key={m.userId}
                onPress={() => openNew(m)}
                style={({ pressed }) => [styles.pickerRow, pressed && styles.rowPressed]}
                accessibilityRole="button"
              >
                <Text style={styles.rowTitle}>{m.displayName || m.username}</Text>
                <Text style={styles.rowMeta}>{m.loginEmail}</Text>
              </Pressable>
            ))
          )}
        </View>
      </Sheet>

      <Sheet
        visible={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.userName ?? t("mobile.notifications.attendance.editor.title")}
        subtitle={t("mobile.notifications.attendance.editor.subtitle")}
        primaryAction={{
          label: t("mobile.notifications.attendance.editor.save"),
          onPress: save,
          loading: upsertM.isPending,
          disabled: deleteM.isPending,
        }}
        secondaryAction={
          draft && !draft.isNew
            ? {
                label: t("mobile.notifications.attendance.editor.remove"),
                onPress: remove,
                disabled: deleteM.isPending || upsertM.isPending,
              }
            : undefined
        }
      >
        {draft ? (
          <Editor draft={draft} onChange={setDraft} />
        ) : null}
      </Sheet>
    </Screen>
  );
}

function Editor({
  draft,
  onChange,
}: {
  draft: DraftSchedule;
  onChange: (next: DraftSchedule) => void;
}) {
  const start = parseHHMM(draft.shiftStart);
  const end = parseHHMM(draft.shiftEnd);

  return (
    <View style={styles.editorBody}>
      <ToggleRow
        label={t("mobile.notifications.attendance.editor.enabled")}
        value={draft.enabled}
        onValueChange={(v) => onChange({ ...draft, enabled: v })}
      />

      <Text style={styles.fieldLabel}>
        {t("mobile.notifications.attendance.editor.shiftStart")}
      </Text>
      <View style={styles.chipGrid}>
        {HOURS.map((h) => (
          <Chip
            key={`sh-${h}`}
            label={`${hh(h)}:00`}
            active={h === start.h}
            onPress={() => onChange({ ...draft, shiftStart: buildTime(h, start.m) })}
          />
        ))}
      </View>
      <View style={styles.chipGrid}>
        {MINUTES.map((m) => (
          <Chip
            key={`sm-${m}`}
            label={`:${String(m).padStart(2, "0")}`}
            active={m === start.m}
            onPress={() => onChange({ ...draft, shiftStart: buildTime(start.h, m) })}
          />
        ))}
      </View>

      <Text style={styles.fieldLabel}>
        {t("mobile.notifications.attendance.editor.shiftEnd")}
      </Text>
      <View style={styles.chipGrid}>
        {HOURS.map((h) => (
          <Chip
            key={`eh-${h}`}
            label={`${hh(h)}:00`}
            active={h === end.h}
            onPress={() => onChange({ ...draft, shiftEnd: buildTime(h, end.m) })}
          />
        ))}
      </View>
      <View style={styles.chipGrid}>
        {MINUTES.map((m) => (
          <Chip
            key={`em-${m}`}
            label={`:${String(m).padStart(2, "0")}`}
            active={m === end.m}
            onPress={() => onChange({ ...draft, shiftEnd: buildTime(end.h, m) })}
          />
        ))}
      </View>

      <Text style={styles.fieldLabel}>
        {t("mobile.notifications.attendance.editor.workDays")}
      </Text>
      <View style={styles.chipGrid}>
        {DOW_KEYS.map((k, idx) => {
          const bit = WORKDAY_BITS[idx]!;
          const active = (draft.workDays & bit) !== 0;
          return (
            <Chip
              key={k}
              label={t(`mobile.notifications.reports.days.${k}`)}
              active={active}
              onPress={() =>
                onChange({
                  ...draft,
                  workDays: active ? draft.workDays & ~bit : draft.workDays | bit,
                })
              }
            />
          );
        })}
      </View>

      <Text style={styles.fieldLabel}>
        {t("mobile.notifications.attendance.editor.graceMinutes")}
      </Text>
      <View style={styles.chipGrid}>
        {GRACE_OPTIONS.map((g) => (
          <Chip
            key={`g-${g}`}
            label={
              g < 0
                ? t("mobile.notifications.attendance.editor.graceInherit")
                : t("mobile.notifications.attendance.editor.graceValue", { n: g })
            }
            active={g === draft.graceMinutes}
            onPress={() => onChange({ ...draft, graceMinutes: g })}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
    marginBottom: spacing.md,
    ...RTL_TEXT,
  },
  noticeOk: { backgroundColor: colors.successLight, color: colors.successStrong },
  noticeErr: { backgroundColor: colors.dangerLight, color: colors.danger },

  sectionTitle: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
    ...RTL_TEXT,
  },
  sectionHint: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 20,
    marginTop: spacing.xs,
    ...RTL_TEXT,
  },
  schedHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    gap: spacing.md,
  },
  list: {
    gap: spacing.sm,
  },
  row: {
    minHeight: MIN_TOUCH,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  rowPressed: {
    backgroundColor: colors.neutralTint,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  rowTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    ...RTL_TEXT,
  },
  rowMeta: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
    ...RTL_TEXT,
  },

  fieldLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    ...RTL_TEXT,
  },
  chipGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  editorBody: {
    gap: spacing.sm,
  },
  pickerList: {
    gap: spacing.xs,
  },
  pickerRow: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    gap: 2,
  },
});
