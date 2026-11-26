import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, notifications } from "@matgary/api-client";
import { CaretDownIcon as CaretDown } from "phosphor-react-native/src/icons/CaretDown";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { ToggleRow } from "@/components/ui/ToggleRow";
import { SkeletonFormField } from "@/components/ui/skeleton";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Notification Center — report scheduling.
 *
 * Reads/writes the authoritative `tenant_report_settings` row via
 * /api/settings/notifications/reports. The reports-tick cron consumes the
 * same row every 15 min to decide whether to fire report.daily / .weekly /
 * .monthly. Defaults preserve the previous hardcoded behavior.
 */

type Settings = notifications.ReportSettings;

const QKEY = ["notification-center", "reports"] as const;

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

export default function ReportsSettingsScreen() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [hoursOpen, setHoursOpen] = useState<"daily" | "weekly" | "monthly" | null>(null);
  const [daysOpen, setDaysOpen] = useState<"weekly" | "monthly" | null>(null);

  const q = useQuery({
    queryKey: QKEY,
    queryFn: () => notifications.getReportSettings(api),
    staleTime: 60_000,
  });

  const m = useMutation({
    mutationFn: (patch: Partial<Settings>) =>
      notifications.updateReportSettings(api, patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: QKEY });
      const prev = qc.getQueryData<Settings>(QKEY);
      if (prev) qc.setQueryData<Settings>(QKEY, { ...prev, ...patch });
      return { prev };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(QKEY, ctx.prev);
      const msg =
        err instanceof ApiError ? err.message : t("mobile.notifications.reports.saveFailed");
      setNotice({ tone: "err", text: msg });
    },
    onSuccess: () => {
      setNotice({ tone: "ok", text: t("mobile.notifications.reports.savedOk") });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: QKEY }),
  });

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(id);
  }, [notice]);

  const s = q.data;

  return (
    <Screen>
      <SettingsHeader
        parentLabel={t("mobile.notifications.reports.back")}
        title={t("mobile.notifications.reports.title")}
        fallback="/settings/notifications"
      />

      <Text style={styles.intro}>{t("mobile.notifications.reports.intro")}</Text>

      {notice ? (
        <View style={[styles.notice, notice.tone === "err" ? styles.noticeErr : styles.noticeOk]}>
          <Text style={styles.noticeText}>{notice.text}</Text>
        </View>
      ) : null}

      {q.isLoading || !s ? (
        <View style={{ gap: spacing.md }}>
          <SkeletonFormField />
          <SkeletonFormField />
          <SkeletonFormField />
        </View>
      ) : (
        <View style={{ gap: spacing.lg }}>
          {/* DAILY */}
          <Card>
            <Text style={styles.sectionTitle}>
              {t("mobile.notifications.reports.daily.label")}
            </Text>
            <Text style={styles.sectionHint}>
              {t("mobile.notifications.reports.daily.hint")}
            </Text>
            <ToggleRow
              label={t("mobile.notifications.reports.fields.enabled")}
              value={s.dailyEnabled}
              onValueChange={(v) => m.mutate({ dailyEnabled: v })}
            />
            <HourPicker
              label={t("mobile.notifications.reports.fields.time")}
              hour={s.dailyHour}
              open={hoursOpen === "daily"}
              onToggle={() => setHoursOpen(hoursOpen === "daily" ? null : "daily")}
              onPick={(h) => {
                setHoursOpen(null);
                m.mutate({ dailyHour: h });
              }}
              disabled={!s.dailyEnabled}
            />
          </Card>

          {/* WEEKLY */}
          <Card>
            <Text style={styles.sectionTitle}>
              {t("mobile.notifications.reports.weekly.label")}
            </Text>
            <Text style={styles.sectionHint}>
              {t("mobile.notifications.reports.weekly.hint")}
            </Text>
            <ToggleRow
              label={t("mobile.notifications.reports.fields.enabled")}
              value={s.weeklyEnabled}
              onValueChange={(v) => m.mutate({ weeklyEnabled: v })}
            />
            <DayOfWeekPicker
              label={t("mobile.notifications.reports.fields.day")}
              dow={s.weeklyDow}
              open={daysOpen === "weekly"}
              onToggle={() => setDaysOpen(daysOpen === "weekly" ? null : "weekly")}
              onPick={(d) => {
                setDaysOpen(null);
                m.mutate({ weeklyDow: d });
              }}
              disabled={!s.weeklyEnabled}
            />
            <HourPicker
              label={t("mobile.notifications.reports.fields.time")}
              hour={s.weeklyHour}
              open={hoursOpen === "weekly"}
              onToggle={() => setHoursOpen(hoursOpen === "weekly" ? null : "weekly")}
              onPick={(h) => {
                setHoursOpen(null);
                m.mutate({ weeklyHour: h });
              }}
              disabled={!s.weeklyEnabled}
            />
          </Card>

          {/* MONTHLY */}
          <Card>
            <Text style={styles.sectionTitle}>
              {t("mobile.notifications.reports.monthly.label")}
            </Text>
            <Text style={styles.sectionHint}>
              {t("mobile.notifications.reports.monthly.hint")}
            </Text>
            <ToggleRow
              label={t("mobile.notifications.reports.fields.enabled")}
              value={s.monthlyEnabled}
              onValueChange={(v) => m.mutate({ monthlyEnabled: v })}
            />
            <DayOfMonthPicker
              label={t("mobile.notifications.reports.fields.dayOfMonth")}
              day={s.monthlyDay}
              open={daysOpen === "monthly"}
              onToggle={() => setDaysOpen(daysOpen === "monthly" ? null : "monthly")}
              onPick={(d) => {
                setDaysOpen(null);
                m.mutate({ monthlyDay: d });
              }}
              disabled={!s.monthlyEnabled}
            />
            <HourPicker
              label={t("mobile.notifications.reports.fields.time")}
              hour={s.monthlyHour}
              open={hoursOpen === "monthly"}
              onToggle={() => setHoursOpen(hoursOpen === "monthly" ? null : "monthly")}
              onPick={(h) => {
                setHoursOpen(null);
                m.mutate({ monthlyHour: h });
              }}
              disabled={!s.monthlyEnabled}
            />
          </Card>
        </View>
      )}
    </Screen>
  );
}

function HourPicker(props: {
  label: string;
  hour: number;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onPick: (h: number) => void;
}) {
  return (
    <View style={styles.fieldBlock}>
      <Pressable
        onPress={props.disabled ? undefined : props.onToggle}
        style={[styles.selectRow, props.disabled && styles.selectRowDisabled]}
        accessibilityRole="button"
        accessibilityState={{ disabled: !!props.disabled, expanded: props.open }}
      >
        <Text style={styles.fieldLabel}>{props.label}</Text>
        <View style={styles.selectValue}>
          <Text style={styles.selectValueText}>{hh(props.hour)}</Text>
          <CaretDown size={14} color={colors.textSecondary} />
        </View>
      </Pressable>
      {props.open ? (
        <View style={styles.chipGrid}>
          {HOURS.map((h) => (
            <Chip
              key={h}
              label={hh(h)}
              active={h === props.hour}
              onPress={() => props.onPick(h)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function DayOfWeekPicker(props: {
  label: string;
  dow: number;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onPick: (d: number) => void;
}) {
  return (
    <View style={styles.fieldBlock}>
      <Pressable
        onPress={props.disabled ? undefined : props.onToggle}
        style={[styles.selectRow, props.disabled && styles.selectRowDisabled]}
        accessibilityRole="button"
        accessibilityState={{ disabled: !!props.disabled, expanded: props.open }}
      >
        <Text style={styles.fieldLabel}>{props.label}</Text>
        <View style={styles.selectValue}>
          <Text style={styles.selectValueText}>
            {t(`mobile.notifications.reports.days.${DOW_KEYS[props.dow] ?? "sun"}`)}
          </Text>
          <CaretDown size={14} color={colors.textSecondary} />
        </View>
      </Pressable>
      {props.open ? (
        <View style={styles.chipGrid}>
          {DOW_KEYS.map((k, idx) => (
            <Chip
              key={k}
              label={t(`mobile.notifications.reports.days.${k}`)}
              active={idx === props.dow}
              onPress={() => props.onPick(idx)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function DayOfMonthPicker(props: {
  label: string;
  day: number;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onPick: (d: number) => void;
}) {
  return (
    <View style={styles.fieldBlock}>
      <Pressable
        onPress={props.disabled ? undefined : props.onToggle}
        style={[styles.selectRow, props.disabled && styles.selectRowDisabled]}
        accessibilityRole="button"
        accessibilityState={{ disabled: !!props.disabled, expanded: props.open }}
      >
        <Text style={styles.fieldLabel}>{props.label}</Text>
        <View style={styles.selectValue}>
          <Text style={styles.selectValueText}>{props.day}</Text>
          <CaretDown size={14} color={colors.textSecondary} />
        </View>
      </Pressable>
      {props.open ? (
        <View style={styles.chipGrid}>
          {MONTH_DAYS.map((d) => (
            <Chip
              key={d}
              label={String(d)}
              active={d === props.day}
              onPress={() => props.onPick(d)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  intro: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.md,
    lineHeight: 20,
  },
  sectionTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  sectionHint: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    lineHeight: 18,
  },
  fieldBlock: {
    marginTop: spacing.sm,
  },
  fieldLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
  },
  selectRow: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  selectRowDisabled: {
    opacity: 0.5,
  },
  selectValue: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  selectValueText: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  chipGrid: {
    marginTop: spacing.sm,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  notice: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  noticeOk: {
    backgroundColor: colors.successLight,
  },
  noticeErr: {
    backgroundColor: colors.dangerLight,
  },
  noticeText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
  },
});
