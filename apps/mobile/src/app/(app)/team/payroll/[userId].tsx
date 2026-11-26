// Mobile — employee payroll detail. Breakdown + light writes (bonus /
// deduction) + "Share statement PDF" through the OS share sheet.
//
// Whole-sheet calculate/finalize are deliberately NOT exposed here; the
// Owner performs those from the web register in V1.

import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";
import { ShareNetworkIcon as ShareNetwork } from "phosphor-react-native/src/icons/ShareNetwork";
import { payroll, ApiError } from "@matgary/api-client";
import { payrollFilename } from "@matgary/domain";

import { api } from "@/api/client";
import { t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { sharePayrollPdf } from "@/payroll/share";

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `−${abs}` : abs;
}

export default function PayrollEmployeeDetailScreen() {
  const params = useLocalSearchParams<{ userId: string; month?: string }>();
  const userId = params.userId as string;
  const month =
    (params.month as string | undefined) ??
    (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    })();

  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["payroll-sheet-mobile", userId, month],
    queryFn: () => payroll.getEmployeePayroll(api, userId, month),
  });
  const sheet = q.data ?? null;
  const locked = sheet?.lifecycle === "FINALIZED" || sheet?.lifecycle === "VOIDED";

  const [kind, setKind] = useState<"bonus" | "deduction">("bonus");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const createAdj = useMutation({
    mutationFn: async () => {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt === 0) {
        throw new Error(t("mobile.payroll.amount"));
      }
      const signed = kind === "bonus" ? Math.abs(amt) : -Math.abs(amt);
      return payroll.createAdjustment(api, {
        employeeId: userId,
        month,
        kind,
        amount: signed,
        reason: reason || null,
      });
    },
    onSuccess: () => {
      setAmount("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["payroll-sheet-mobile", userId, month] });
      qc.invalidateQueries({ queryKey: ["payroll-mobile", month] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? e.message : (e as Error)?.message ?? "error";
      Alert.alert(t("mobile.payroll.title"), msg);
    },
  });

  const voidAdj = useMutation({
    mutationFn: (id: string) => payroll.voidAdjustment(api, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["payroll-sheet-mobile", userId, month] }),
  });

  const sharePdf = async () => {
    if (!sheet) return;
    try {
      const filename = payrollFilename({
        periodStart: sheet.periodStart,
        entityName: sheet.employeeName,
        kind: "statement",
      });
      await sharePayrollPdf({ month, employeeId: userId, filename });
    } catch (e) {
      Alert.alert(t("mobile.payroll.sharePdf"), (e as Error)?.message ?? "error");
    }
  };

  return (
    <Screen title={sheet?.employeeName ?? t("mobile.payroll.title")}>
      <BackLink label={t("mobile.payroll.detailBack")} fallback="/team/payroll" />

      {q.isLoading && (
        <View style={{ gap: spacing.md, marginTop: spacing.md }}>
          <SkeletonListRow />
          <SkeletonListRow />
          <SkeletonListRow />
        </View>
      )}

      {sheet && (
        <ScrollView
          contentContainerStyle={{ paddingBottom: spacing.xxl, gap: spacing.lg }}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.statusCard}>
            <Text style={styles.statusLabel}>
              {t("mobile.payroll.title")} · {month}
            </Text>
            <Text style={styles.statusValue}>{sheet.lifecycle}</Text>
            <Text style={styles.net}>
              {t("mobile.payroll.netLabel")}:{" "}
              <Text style={styles.netValue}>{fmtMoney(sheet.snapshot.netAmount)}</Text>
            </Text>
          </View>

          <Button
            onPress={sharePdf}
            variant="outline"
            icon={ShareNetwork}
            label={t("mobile.payroll.sharePdf")}
          />

          {sheet.snapshot.warnings.length > 0 && (
            <View style={styles.warningCard}>
              <View style={styles.warningHeader}>
                <WarningCircle size={14} color={colors.warning} />
                <Text style={styles.warningTitle}>{t("mobile.payroll.warnings")}</Text>
              </View>
              {sheet.snapshot.warnings.map((w, i) => {
                // Prefer the localized label for the machine code; the
                // engine's English `message` is only used as a last-resort
                // fallback (e.g. for future codes we haven't translated yet).
                const localized = t(`mobile.payroll.warningCodes.${w.code}`);
                const label = localized.startsWith("mobile.") ? w.message : localized;
                return (
                  <Text key={i} style={styles.warningItem}>
                    • {label}
                  </Text>
                );
              })}
            </View>
          )}

          {/* Attendance */}
          <Section title={t("mobile.payroll.attendance")}>
            <KV
              label={t("mobile.payroll.regularHours")}
              value={sheet.snapshot.regularHours.toFixed(1)}
            />
            <KV
              label={t("mobile.payroll.overtimeHours")}
              value={sheet.snapshot.overtimeHours.toFixed(1)}
            />
            {sheet.snapshot.paidLeaveDays > 0 && (
              <KV
                label={t("mobile.payroll.paidLeave")}
                value={String(sheet.snapshot.paidLeaveDays)}
              />
            )}
            {sheet.snapshot.unpaidLeaveDays > 0 && (
              <KV
                label={t("mobile.payroll.unpaidLeave")}
                value={String(sheet.snapshot.unpaidLeaveDays)}
              />
            )}
          </Section>

          {/* Earnings */}
          <Section title={t("mobile.payroll.gross")}>
            {sheet.snapshot.baseEarnings > 0 && (
              <KV label={t("mobile.payroll.base")} value={fmtMoney(sheet.snapshot.baseEarnings)} />
            )}
            {sheet.snapshot.hourlyEarnings > 0 && (
              <KV label={t("mobile.payroll.overtimeHours")} value={fmtMoney(sheet.snapshot.hourlyEarnings)} />
            )}
            {sheet.snapshot.commissionGrossSales > 0 && (
              <>
                <KV
                  label={t("mobile.payroll.sales")}
                  value={fmtMoney(sheet.snapshot.commissionGrossSales)}
                />
                {sheet.snapshot.commissionReturnedValue > 0 && (
                  <KV
                    label={t("mobile.payroll.returns")}
                    value={`−${fmtMoney(sheet.snapshot.commissionReturnedValue)}`}
                  />
                )}
                <KV
                  label={t("mobile.payroll.commission")}
                  value={fmtMoney(sheet.snapshot.commissionAmount)}
                />
              </>
            )}
          </Section>

          {/* Adjustments */}
          <Section title={t("mobile.payroll.adjustments")}>
            {sheet.snapshot.adjustments.length === 0 && (
              <Text style={styles.muted}>{t("mobile.payroll.adjustmentsEmpty")}</Text>
            )}
            {sheet.snapshot.adjustments.map((a) => (
              <View key={a.id} style={styles.adjRow}>
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      styles.adjAmount,
                      { color: a.amount >= 0 ? colors.success : colors.danger },
                    ]}
                  >
                    {a.amount >= 0 ? "+" : "−"}
                    {Math.abs(a.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </Text>
                  <Text style={styles.adjMeta}>
                    {(() => {
                      const localized = t(`mobile.payroll.adjustmentKinds.${a.kind}`);
                      return localized.startsWith("mobile.") ? a.kind : localized;
                    })()}
                    {a.reason ? ` — ${a.reason}` : ""}
                  </Text>
                </View>
                {!locked && (
                  <Pressable onPress={() => voidAdj.mutate(a.id)} hitSlop={12}>
                    <Trash size={16} color={colors.danger} />
                  </Pressable>
                )}
              </View>
            ))}

            {!locked && (
              <View style={styles.adjForm}>
                <Segmented<"bonus" | "deduction">
                  items={[
                    { key: "bonus", label: t("mobile.payroll.addBonus") },
                    { key: "deduction", label: t("mobile.payroll.addDeduction") },
                  ]}
                  value={kind}
                  onChange={setKind}
                />
                <Field
                  label={t("mobile.payroll.amount")}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                />
                <Field
                  label={t("mobile.payroll.reason")}
                  value={reason}
                  onChangeText={setReason}
                />
                <Button
                  onPress={() => createAdj.mutate()}
                  disabled={createAdj.isPending || !amount}
                  icon={Plus}
                  label={t("mobile.payroll.save")}
                />
              </View>
            )}

            {locked && (
              <Text style={styles.muted}>
                {t("mobile.payroll.compensationLocked").replace(
                  "{state}",
                  sheet.lifecycle.toLowerCase(),
                )}
              </Text>
            )}
          </Section>
        </ScrollView>
      )}
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  statusCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  statusLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  statusValue: {
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
    ...RTL_TEXT,
  },
  net: {
    marginTop: spacing.xs,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  netValue: {
    fontFamily: fonts.bold,
    fontSize: 20,
    color: colors.success,
  },
  warningCard: {
    backgroundColor: colors.warningTint,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  warningHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  warningTitle: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.warningStrong,
  },
  warningItem: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.warningStrong,
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    textTransform: "uppercase",
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  kv: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  kvLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  kvValue: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.text,
  },
  muted: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  adjRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  adjAmount: {
    fontFamily: fonts.bold,
    fontSize: 15,
  },
  adjMeta: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  adjForm: {
    gap: spacing.md,
    marginTop: spacing.md,
  },
});
