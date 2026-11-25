// Mobile payroll register — employee cards, one tap → detail.
//
// Design brief:
//   • Cards instead of a spreadsheet; the register table does not transfer
//     to a 390px phone cleanly.
//   • Each card shows employee, base, net, status badge, and the top
//     warning (if any).
//   • Tap → /team/payroll/[userId]
//   • No "finalize whole period" button on mobile; that stays web-only.

import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { CalendarBlankIcon as CalendarBlank } from "phosphor-react-native/src/icons/CalendarBlank";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";
import { payroll } from "@matgary/api-client";

import { api } from "@/api/client";
import { t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { BackLink } from "@/components/ui/BackLink";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";

function currentMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `−${abs}` : abs;
}

function lifecycleTint(lc: payroll.PayrollLifecycle): { bg: string; fg: string; label: string } {
  switch (lc) {
    case "DRAFT":
      return { bg: "#dbeafe", fg: "#1d4ed8", label: t("mobile.payroll.statusDraft") };
    case "FINALIZED":
      return { bg: colors.successLight, fg: colors.success, label: t("mobile.payroll.statusFinalized") };
    case "VOIDED":
      return { bg: "#e5e7eb", fg: "#6b7280", label: t("mobile.payroll.statusVoided") };
    default:
      return { bg: "#f3f4f6", fg: "#9ca3af", label: t("mobile.payroll.statusMissing") };
  }
}

export default function PayrollRegisterScreen() {
  const router = useRouter();
  const [month, setMonth] = useState<string>(currentMonthIso());
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);

  const q = useQuery({
    queryKey: ["payroll-mobile", month],
    queryFn: () => payroll.listPayrollMonth(api, month),
  });
  const rows = q.data ?? [];

  const totals = useMemo(() => {
    let net = 0;
    for (const r of rows) if (r.lifecycle !== "VOIDED") net += r.snapshot.netAmount;
    return { net };
  }, [rows]);

  return (
    <Screen title={t("mobile.payroll.title")}>
      <BackLink label={t("mobile.payroll.backToTeam")} fallback="/team" />

      <Pressable
        onPress={() => setMonthPickerOpen(true)}
        style={styles.monthPill}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.payroll.changeMonth")}
      >
        <CalendarBlank size={16} color={colors.textSecondary} />
        <Text style={styles.monthLabel}>{month}</Text>
      </Pressable>

      <Text style={styles.totalLine}>
        {t("mobile.payroll.totalNet")}{" "}
        <Text style={styles.totalValue}>{fmtMoney(totals.net)}</Text>
      </Text>

      {q.isLoading && (
        <View style={{ gap: spacing.md, marginTop: spacing.md }}>
          <SkeletonListRow />
          <SkeletonListRow />
          <SkeletonListRow />
        </View>
      )}

      {!q.isLoading && rows.length === 0 && (
        <EmptyState
          title={t("mobile.payroll.emptyTitle")}
          hint={t("mobile.payroll.emptyMessage")}
        />
      )}

      <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxl, gap: spacing.md }}
        showsVerticalScrollIndicator={false}
      >
        {rows.map((row) => {
          const tint = lifecycleTint(row.lifecycle);
          const topWarning = row.snapshot.warnings[0];
          return (
            <Pressable
              key={row.employeeId}
              onPress={() => router.push(`/team/payroll/${row.employeeId}?month=${month}`)}
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              accessibilityRole="button"
            >
              <View style={styles.cardRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.employee} numberOfLines={1}>
                    {row.employeeName ?? row.employeeId.slice(0, 8)}
                  </Text>
                  <Text style={styles.role} numberOfLines={1}>
                    {row.role}
                  </Text>
                </View>
                <View style={[styles.badge, { backgroundColor: tint.bg }]}>
                  <Text style={[styles.badgeText, { color: tint.fg }]}>{tint.label}</Text>
                </View>
              </View>

              <View style={styles.cardFooter}>
                <View>
                  <Text style={styles.footerLabel}>{t("mobile.payroll.base")}</Text>
                  <Text style={styles.footerValue}>{fmtMoney(row.snapshot.baseEarnings)}</Text>
                </View>
                <View>
                  <Text style={styles.footerLabel}>{t("mobile.payroll.net")}</Text>
                  <Text style={[styles.footerValue, styles.footerNet]}>
                    {fmtMoney(row.snapshot.netAmount)}
                  </Text>
                </View>
              </View>

              {topWarning && (
                <View style={styles.warningRow}>
                  <WarningCircle size={14} color={colors.warning} />
                  <Text style={styles.warningText} numberOfLines={2}>
                    {topWarning.message}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      <Modal
        animationType="slide"
        transparent
        visible={monthPickerOpen}
        onRequestClose={() => setMonthPickerOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setMonthPickerOpen(false)}>
          <View style={styles.monthModal}>
            <Text style={styles.monthModalTitle}>{t("mobile.payroll.changeMonth")}</Text>
            <ScrollView>
              {monthChoices().map((m) => (
                <Pressable
                  key={m}
                  onPress={() => {
                    setMonth(m);
                    setMonthPickerOpen(false);
                  }}
                  style={({ pressed }) => [styles.monthChoice, pressed && styles.cardPressed]}
                >
                  <Text style={[styles.monthChoiceText, m === month && styles.monthChoiceActive]}>
                    {m}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </Screen>
  );
}

function monthChoices(): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const styles = StyleSheet.create({
  title: {
    fontFamily: fonts.bold,
    fontSize: 20,
    color: colors.text,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    ...RTL_TEXT,
  },
  monthPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    backgroundColor: colors.card,
  },
  monthLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
    ...RTL_TEXT,
  },
  totalLine: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: spacing.md,
    ...RTL_TEXT,
  },
  totalValue: {
    fontFamily: fonts.bold,
    color: colors.text,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
    minHeight: MIN_TOUCH,
  },
  cardPressed: {
    opacity: 0.85,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  employee: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    ...RTL_TEXT,
  },
  role: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  badgeText: {
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  cardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: spacing.xs,
  },
  footerLabel: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  footerValue: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  footerNet: {
    color: colors.success,
    fontSize: 18,
  },
  warningRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  warningText: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.warning,
    flex: 1,
    ...RTL_TEXT,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  monthModal: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    maxHeight: "60%",
  },
  monthModalTitle: {
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
    marginBottom: spacing.md,
    ...RTL_TEXT,
  },
  monthChoice: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  monthChoiceText: {
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.text,
  },
  monthChoiceActive: {
    color: colors.accent,
    fontFamily: fonts.bold,
  },
});
