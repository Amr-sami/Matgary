import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarBlankIcon as CalendarBlank } from "phosphor-react-native/src/icons/CalendarBlank";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { ClockIcon as Clock } from "phosphor-react-native/src/icons/Clock";
import { PencilSimpleIcon as PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";
import { ApiError, team } from "@matgary/api-client";

import { api } from "@/api/client";
import { getLocale, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { BackLink } from "@/components/ui/BackLink";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { NativeDatePicker, dateToIsoDay, isoDayToDate } from "@/components/ui/DateField";
import { CaretDownIcon as CaretDown } from "phosphor-react-native/src/icons/CaretDown";
import { CaretUpIcon as CaretUp } from "phosphor-react-native/src/icons/CaretUp";

import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";
import { errorText as sharedErrorText } from "@/lib/errors";

/**
 * /team/attendance — the manager's roster for one day (port of
 * components/team/AttendanceRoster.tsx, doc 02 §2.8).
 *
 * Status, log, totals and every edit all come from one source:
 * GET /api/attendance/events?from&to over the selected day's *device-local*
 * boundaries. The web also merges GET /api/attendance/today for status, but
 * that route uses the server's day (doc 02 §2.8), so on a phone in another TZ
 * a member could read "present" next to an empty log near midnight. Until the
 * server computes boundaries in the tenant's TZ, deriving status from the
 * same events the log shows keeps the roster self-consistent.
 *
 * Manager actions are the web's: check-in / check-out on behalf of a member
 * (POST, source manager_attest), edit an event's type / time / note (PATCH),
 * resolve a review flag (PATCH requiresReview:false), delete (DELETE).
 */

type AttendanceEvent = team.AttendanceEvent;
type AttendanceType = team.AttendanceType;
type RosterStatus = team.RosterStatus;

type DayKey = "today" | "yesterday" | "custom";

interface RosterLine {
  userId: string;
  displayName: string;
  username: string;
  status: RosterStatus;
  needsReview: boolean;
  firstIn: string | null;
  lastOut: string | null;
  hours: number;
  events: AttendanceEvent[];
}

const pad = (n: number) => String(n).padStart(2, "0");

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


function hhmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "HH:MM" on `day` → ISO, or null when malformed. */
function combine(day: Date, time: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, min, 0, 0).toISOString();
}

function errorText(error: unknown, fallback: string): string {
  // Shared helper: walls/codes become the app's sentences, prose 4xx bodies pass.
  return sharedErrorText(error, fallback);
}

const STATUS = (): Record<
  RosterStatus | "review",
  { label: string; variant: "success" | "neutral" | "outofstock" | "lowstock" }
> => ({
  checked_in: { label: t("mobile.team.attendance.present"), variant: "success" },
  checked_out: { label: t("mobile.team.attendance.out"), variant: "neutral" },
  absent: { label: t("mobile.team.attendance.absent"), variant: "outofstock" },
  review: { label: t("mobile.team.attendance.review"), variant: "lowstock" },
});

const SOURCE = (): Record<string, string> => ({
  manager_attest: t("app.team.dayEvents.source.manager_attest"),
  geofence: t("app.team.dayEvents.source.geofence"),
  qr: t("app.team.dayEvents.source.qr"),
  manual: t("app.team.dayEvents.source.manual"),
});

export default function TeamAttendanceScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const permissions = useSession((s) => s.me?.permissions);
  const canManage = new Set(permissions ?? []).has("manage_team");

  const [dayKey, setDayKey] = useState<DayKey>("today");
  const [customDay, setCustomDay] = useState<Date | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(null), 3500);
    return () => clearTimeout(id);
  }, [banner]);

  const day = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (dayKey === "yesterday") d.setDate(d.getDate() - 1);
    if (dayKey === "custom") return customDay ?? d;
    return d;
  }, [dayKey, customDay]);
  const dayStr = ymd(day);
  const isToday = dayStr === ymd(new Date());
  const from = day.toISOString();
  const to = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999).toISOString();

  // -- data ---------------------------------------------------------------
  const teamQ = useQuery({
    queryKey: ["team"],
    enabled: canManage,
    queryFn: () => team.listTeam(api),
  });
  const eventsQ = useQuery({
    queryKey: ["attendance", "events", dayStr],
    enabled: canManage,
    queryFn: () => team.listAttendanceEvents(api, { from, to }),
  });
  const roster: RosterLine[] = useMemo(() => {
    const members = (teamQ.data ?? []).filter((m) => m.role !== "owner");
    const byEmployee = new Map<string, AttendanceEvent[]>();
    for (const e of eventsQ.data ?? []) {
      const list = byEmployee.get(e.employeeId) ?? [];
      list.push(e);
      byEmployee.set(e.employeeId, list);
    }
    return members.map((m) => {
      const events = (byEmployee.get(m.userId) ?? []).sort((a, b) =>
        a.occurredAt < b.occurredAt ? -1 : 1,
      );
      const last = events[events.length - 1] ?? null;
      const derived: RosterStatus =
        last?.type === "check_in" ? "checked_in" : last?.type === "check_out" ? "checked_out" : "absent";
      let hours = 0;
      let openIn: string | null = null;
      for (const e of events) {
        if (e.type === "check_in") openIn = e.occurredAt;
        else if (openIn) {
          hours += Math.max(0, (Date.parse(e.occurredAt) - Date.parse(openIn)) / 3_600_000);
          openIn = null;
        }
      }
      return {
        userId: m.userId,
        displayName: m.displayName,
        username: m.username,
        status: derived,
        needsReview: events.some((e) => e.requiresReview),
        firstIn: events.find((e) => e.type === "check_in")?.occurredAt ?? null,
        lastOut: [...events].reverse().find((e) => e.type === "check_out")?.occurredAt ?? null,
        hours,
        events,
      };
    });
  }, [teamQ.data, eventsQ.data]);

  const totals = useMemo(
    () => ({
      present: roster.filter((r) => r.status === "checked_in").length,
      out: roster.filter((r) => r.status === "checked_out").length,
      absent: roster.filter((r) => r.status === "absent").length,
      review: roster.filter((r) => r.needsReview).length,
      hours: roster.reduce((s, r) => s + r.hours, 0),
    }),
    [roster],
  );

  // -- mutations ----------------------------------------------------------
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["attendance"] }),
    ]);
  };

  const [pendingAction, setPendingAction] = useState<{
    line: RosterLine;
    type: AttendanceType;
  } | null>(null);
  const [actionTime, setActionTime] = useState("");

  const record = useMutation({
    mutationFn: (input: { employeeId: string; type: AttendanceType; occurredAt?: string }) =>
      team.recordAttendanceEvent(api, { ...input, source: "manager_attest" }),
    onSuccess: async (_res, input) => {
      setPendingAction(null);
      await invalidate();
      setBanner({
        kind: "ok",
        text: input.type === "check_in" ? t("app.team.roster.toast.checkedIn") : t("app.team.roster.toast.checkedOut"),
      });
    },
    onError: (e) => setBanner({ kind: "error", text: errorText(e, t("app.team.roster.toast.saveFailed")) }),
  });

  const onAction = (line: RosterLine, type: AttendanceType) => {
    if (isToday) {
      record.mutate({ employeeId: line.userId, type });
      return;
    }
    // A past day has no "now" — ask for the time.
    const now = new Date();
    setActionTime(`${pad(now.getHours())}:${pad(now.getMinutes())}`);
    setPendingAction({ line, type });
  };

  const [editing, setEditing] = useState<AttendanceEvent | null>(null);
  const [editType, setEditType] = useState<AttendanceType>("check_in");
  const [editTime, setEditTime] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const openEdit = (e: AttendanceEvent) => {
    setEditType(e.type);
    setEditTime(hhmm(e.occurredAt));
    setEditNote(e.note ?? "");
    setEditError(null);
    setEditing(e);
  };

  const update = useMutation({
    mutationFn: (args: { id: string; input: Parameters<typeof team.updateAttendanceEvent>[2] }) =>
      team.updateAttendanceEvent(api, args.id, args.input),
    onSuccess: async () => {
      setEditing(null);
      await invalidate();
      setBanner({ kind: "ok", text: t("app.team.editEvent.saveSuccess") });
    },
    onError: (e) => setBanner({ kind: "error", text: errorText(e, t("app.team.dayEvents.toast.updateFailed")) }),
  });

  const del = useMutation({
    mutationFn: (id: string) => team.deleteAttendanceEvent(api, id),
    onSuccess: invalidate,
    onError: (e) => setBanner({ kind: "error", text: errorText(e, t("app.team.dayEvents.toast.deleteFailed")) }),
  });
  const confirmDelete = (e: AttendanceEvent) =>
    Alert.alert(t("app.team.dayEvents.action.delete"), t("mobile.team.attendance.deleteConfirm"), [
      { text: t("app.team.editEvent.cancel"), style: "cancel" },
      { text: t("app.team.dayEvents.action.delete"), style: "destructive", onPress: () => del.mutate(e.id) },
    ]);

  const onPickDay = (d: Date) => {
    setCustomDay(d);
    setDayKey("custom");
  };

  // -- render -------------------------------------------------------------
  const rtl = getLocale() === "ar";
  const busy = record.isPending || update.isPending || del.isPending;
  const loading = teamQ.isLoading || eventsQ.isLoading;
  const error = teamQ.error ?? eventsQ.error;

  return (
    <Screen
      onRefresh={() => {
        void teamQ.refetch();
        void eventsQ.refetch();
      }}
      refreshing={eventsQ.isRefetching}
      // "‹ Team" in the FIXED header band — the one BackLink recipe, at the
      // same y as team/[userId] (HeaderAccessories above it on both).
      header={
        <View style={styles.fixedHeader}>
          <HeaderAccessories />
          <BackLink label={t("mobile.team.back")} onPress={() => router.navigate("/team")} />
        </View>
      }
    >
      {/* The settings sub-page shape: title + subtitle scroll with the page. */}
      <View style={styles.header}>
        <Text style={styles.title}>
          {isToday ? t("app.team.roster.todayHeading") : t("mobile.team.attendance.dayHeading")}
        </Text>
        <Text style={styles.subtitle}>{shortDate(day.toISOString())}</Text>
      </View>

      {!canManage ? (
        <EmptyState title={t("mobile.common.forbidden")} />
      ) : (
        <View style={styles.stack}>
          {/* Day picker */}
          <View style={styles.chips}>
            <Chip label={t("mobile.team.attendance.today")} active={dayKey === "today"} onPress={() => setDayKey("today")} />
            <Chip
              label={t("mobile.team.attendance.yesterday")}
              active={dayKey === "yesterday"}
              onPress={() => setDayKey("yesterday")}
            />
            {/* Third chip opens the calendar; once a day is picked it reads as that day. */}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: dayKey === "custom" }}
              accessibilityLabel={t("mobile.team.attendance.pickDateTitle")}
              onPress={() => setPickerOpen(true)}
              style={({ pressed }) => [
                styles.dateChip,
                dayKey === "custom" ? styles.dateChipActive : styles.dateChipInactive,
                pressed && dayKey !== "custom" && styles.dateChipPressed,
              ]}
            >
              <CalendarBlank size={16} color={dayKey === "custom" ? colors.onAccent : colors.text} />
              <Text
                numberOfLines={1}
                style={[styles.dateChipText, dayKey === "custom" ? styles.dateChipTextActive : styles.dateChipTextInactive]}
              >
                {customDay ? shortDate(customDay.toISOString()) : t("mobile.team.attendance.pickDate")}
              </Text>
            </Pressable>
          </View>

          {banner ? (
            <View style={[styles.banner, banner.kind === "ok" ? styles.bannerOk : styles.bannerError]}>
              <Text style={[styles.bannerText, banner.kind === "ok" ? styles.bannerTextOk : styles.bannerTextError]}>
                {banner.text}
              </Text>
            </View>
          ) : null}

          {loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : error ? (
            <EmptyState title={errorText(error, t("app.team.roster.loadFailed"))} />
          ) : roster.length === 0 ? (
            <EmptyState title={t("mobile.team.attendance.noStaff")} />
          ) : (
            <>
              {/* Totals */}
              <View style={styles.pills}>
                <Badge label={t("app.team.roster.pill.present", { n: totals.present })} variant="success" />
                <Badge label={t("app.team.roster.pill.out", { n: totals.out })} variant="neutral" />
                <Badge label={t("app.team.roster.pill.absent", { n: totals.absent })} variant="outofstock" />
                {totals.review > 0 ? (
                  <Badge label={t("app.team.roster.pill.review", { n: totals.review })} variant="lowstock" />
                ) : null}
                <Badge
                  label={`${t("mobile.team.hoursTotal")} ${t("mobile.team.hoursShort", { h: totals.hours.toFixed(1) })}`}
                  variant="accent"
                />
              </View>

              {/* Roster */}
              <View style={styles.list}>
                {roster.map((line) => {
                  const open = expanded === line.userId;
                  const st = STATUS()[line.needsReview ? "review" : line.status];
                  return (
                    <View key={line.userId} style={styles.card} testID="roster-row">
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setExpanded(open ? null : line.userId)}
                        style={styles.rowHead}
                      >
                        <View style={styles.avatar}>
                          <Text style={styles.initial}>
                            {(line.displayName || line.username || "?").trim().charAt(0)}
                          </Text>
                        </View>
                        <View style={styles.body}>
                          <Text numberOfLines={1} style={styles.name}>
                            {line.displayName || line.username}
                          </Text>
                          <Text numberOfLines={1} style={styles.meta}>
                            {line.firstIn
                              ? `${t("app.team.roster.status.checkedInAt", { time: hhmm(line.firstIn) })}${
                                  line.lastOut
                                    ? ` · ${t("app.team.roster.status.checkedOutAt", { time: hhmm(line.lastOut) })}`
                                    : ""
                                }${line.hours > 0 ? ` · ${t("mobile.team.hoursShort", { h: line.hours.toFixed(1) })}` : ""}`
                              : t("app.team.roster.status.notYet")}
                          </Text>
                        </View>
                        <Badge label={st.label} variant={st.variant} />
                        {/* Expand/collapse is vertical; the sideways caret means "opens a
                            detail" on the roster one screen back. */}
                        {open ? <CaretUp size={16} color={colors.textSecondary} /> : <CaretDown size={16} color={colors.textSecondary} />}
                      </Pressable>

                      <View style={styles.actions}>
                        {line.status === "checked_in" ? (
                          <Button
                            label={t("app.team.roster.action.checkOut")}
                            variant="outline"
                            onPress={() => onAction(line, "check_out")}
                            disabled={busy}
                            style={styles.grow}
                          />
                        ) : (
                          <Button
                            label={t("app.team.roster.action.checkIn")}
                            onPress={() => onAction(line, "check_in")}
                            disabled={busy}
                            style={styles.grow}
                          />
                        )}
                      </View>

                      {open ? (
                        <View style={styles.log}>
                          <Text style={styles.logTitle}>
                            {t("app.team.dayEvents.title", { name: line.displayName || line.username })}
                          </Text>
                          {line.events.length === 0 ? (
                            <Text style={styles.meta}>{t("app.team.dayEvents.empty")}</Text>
                          ) : (
                            line.events.map((e) => (
                              <View key={e.id} style={styles.eventRow}>
                                {e.requiresReview ? (
                                  <WarningCircle size={18} color={colors.warningStrong} weight="fill" />
                                ) : e.type === "check_in" ? (
                                  <CheckCircle size={18} color={colors.successStrong} weight="fill" />
                                ) : (
                                  <Clock size={18} color={colors.textSecondary} />
                                )}
                                <View style={styles.body}>
                                  <Text style={styles.eventMain}>
                                    {e.type === "check_in"
                                      ? t("app.team.dayEvents.event.checkIn")
                                      : t("app.team.dayEvents.event.checkOut")}{" "}
                                    <Text style={styles.eventTime}>{hhmm(e.occurredAt)}</Text>
                                    {e.requiresReview ? (
                                      <Text style={styles.eventReview}> {t("app.team.dayEvents.event.needsReview")}</Text>
                                    ) : null}
                                  </Text>
                                  <Text numberOfLines={2} style={styles.meta}>
                                    {SOURCE()[e.source] ?? e.source}
                                    {e.note ? ` · ${e.note}` : ""}
                                  </Text>
                                </View>
                                {e.requiresReview ? (
                                  <IconButton
                                    label={t("app.team.dayEvents.action.clearReview")}
                                    onPress={() => update.mutate({ id: e.id, input: { requiresReview: false } })}
                                    disabled={busy}
                                  >
                                    <CheckCircle size={20} color={colors.accent} />
                                  </IconButton>
                                ) : null}
                                <IconButton label={t("app.team.dayEvents.action.edit")} onPress={() => openEdit(e)} disabled={busy}>
                                  <PencilSimple size={20} color={colors.accent} />
                                </IconButton>
                                <IconButton label={t("app.team.dayEvents.action.delete")} onPress={() => confirmDelete(e)} disabled={busy}>
                                  <Trash size={20} color={colors.danger} />
                                </IconButton>
                              </View>
                            ))
                          )}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </View>
      )}

      {/* Attendance is never in the future: today is the latest pickable day. */}
      <NativeDatePicker
        visible={pickerOpen}
        value={dateToIsoDay(customDay ?? day)}
        max={dateToIsoDay(new Date())}
        title={t("mobile.team.attendance.pickDateTitle")}
        onChange={(iso) => {
          const d = isoDayToDate(iso);
          if (d) onPickDay(d);
        }}
        onClose={() => setPickerOpen(false)}
      />

      {/* Past-day manual entry: needs a time */}
      <Modal visible={pendingAction !== null} animationType="slide" onRequestClose={() => setPendingAction(null)}>
        <View style={[styles.modal, directionStyle(rtl)]}>
          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>
              {pendingAction?.type === "check_in"
                ? t("app.team.roster.action.checkIn")
                : t("app.team.roster.action.checkOut")}
            </Text>
            <Text style={styles.meta}>
              {t("mobile.team.attendance.pastDayHint", { date: shortDate(day.toISOString()) })}
              {pendingAction ? ` — ${pendingAction.line.displayName}` : ""}
            </Text>
            <Field
              label={t("mobile.team.attendance.time")}
              value={actionTime}
              onChangeText={setActionTime}
              placeholder="09:00"
              keyboardType="numbers-and-punctuation"
              ltr
            />
            {pendingAction && !combine(day, actionTime) ? (
              <Text style={styles.fieldError}>{t("mobile.team.attendance.invalidTime")}</Text>
            ) : null}
            <Button
              label={t("app.team.editEvent.save")}
              loading={record.isPending}
              disabled={!pendingAction || !combine(day, actionTime)}
              onPress={() => {
                const iso = pendingAction ? combine(day, actionTime) : null;
                if (!pendingAction || !iso) return;
                record.mutate({ employeeId: pendingAction.line.userId, type: pendingAction.type, occurredAt: iso });
              }}
            />
            <Button label={t("app.team.editEvent.cancel")} variant="ghost" onPress={() => setPendingAction(null)} />
          </ScrollView>
        </View>
      </Modal>

      {/* Edit event */}
      <Modal visible={editing !== null} animationType="slide" onRequestClose={() => setEditing(null)}>
        <View style={[styles.modal, directionStyle(rtl)]}>
          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t("app.team.editEvent.title")}</Text>
            <Text style={styles.fieldLabel}>{t("app.team.editEvent.typeLabel")}</Text>
            <Segmented<AttendanceType>
              equal
              items={[
                { key: "check_in", label: t("app.team.editEvent.checkIn") },
                { key: "check_out", label: t("app.team.editEvent.checkOut") },
              ]}
              value={editType}
              onChange={setEditType}
            />
            <Field
              label={t("app.team.editEvent.timeLabel")}
              value={editTime}
              onChangeText={(v) => {
                setEditTime(v);
                setEditError(null);
              }}
              placeholder="09:00"
              keyboardType="numbers-and-punctuation"
              ltr
            />
            <Field
              label={t("app.team.editEvent.noteLabel")}
              placeholder={t("app.team.editEvent.notePlaceholder")}
              value={editNote}
              onChangeText={setEditNote}
              multiline
            />
            {editError ? <Text style={styles.fieldError}>{editError}</Text> : null}
            <Button
              label={t("app.team.editEvent.save")}
              loading={update.isPending}
              disabled={!editing}
              onPress={() => {
                if (!editing) return;
                const iso = combine(new Date(editing.occurredAt), editTime);
                if (!iso) {
                  setEditError(t("mobile.team.attendance.invalidTime"));
                  return;
                }
                update.mutate({
                  id: editing.id,
                  input: { type: editType, occurredAt: iso, note: editNote.trim() || null },
                });
              }}
            />
            <Button label={t("app.team.editEvent.cancel")} variant="ghost" onPress={() => setEditing(null)} />
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}

function IconButton({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  // Same shape as the settings sub-pages: back link, then title, then subtitle.
  fixedHeader: { gap: spacing.xs, alignItems: "flex-start" },
  header: { gap: spacing.xs, alignItems: "flex-start" },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  // Chip's metrics with a leading glyph — Chip itself takes no icon.
  dateChip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    flexShrink: 0,
  },
  dateChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  dateChipInactive: { backgroundColor: colors.bg, borderColor: colors.border },
  dateChipPressed: { backgroundColor: colors.accentLight },
  dateChipText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14 },
  dateChipTextActive: { color: colors.onAccent },
  dateChipTextInactive: { color: colors.text },
  grow: { flex: 1 },
  fieldError: { fontFamily: fonts.regular, fontSize: 12, color: colors.danger, marginTop: spacing.xs, ...RTL_TEXT },
  banner: { borderRadius: radius.md, padding: spacing.md },
  bannerOk: { backgroundColor: colors.successLight },
  bannerError: { backgroundColor: colors.dangerLight },
  bannerText: { fontFamily: fonts.medium, fontSize: 14, ...RTL_TEXT },
  bannerTextOk: { color: colors.successStrong },
  bannerTextError: { color: colors.danger },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  list: { gap: spacing.md },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...elevation.card,
  },
  rowHead: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: MIN_TOUCH },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  initial: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 16, color: colors.accent },
  body: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  actions: { flexDirection: "row", gap: spacing.sm },
  log: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md, gap: spacing.sm },
  logTitle: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  eventRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: MIN_TOUCH },
  eventMain: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  eventTime: { ...RTL_TEXT, fontFamily: fonts.semibold, fontVariant: ["tabular-nums"] },
  eventReview: { ...RTL_TEXT, color: colors.warningStrong, fontSize: 12 },
  iconButton: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalBody: { padding: spacing.xl, paddingTop: spacing.xxl * 1.5, gap: spacing.lg },
  modalTitle: { fontFamily: fonts.bold, fontSize: 20, color: colors.text, ...RTL_TEXT },
  fieldLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
});
