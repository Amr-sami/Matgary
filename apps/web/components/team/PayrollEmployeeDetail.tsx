"use client";

// Employee payroll detail — modal surface opened from the register.
//
// Shows the full snapshot for ONE employee + month, plus:
//   • Add bonus / deduction (writes through /api/payroll/adjustments)
//   • Download statement PDF
//
// For FINALIZED sheets, mutations are blocked by the server; the UI
// greys out the write controls and explains why.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { Download, AlertTriangle, Trash2 } from "@/lib/icons";

type Lifecycle = "MISSING" | "DRAFT" | "FINALIZED" | "VOIDED";

interface SnapshotWarning {
  code: string;
  message: string;
}
interface AdjustmentSnapshot {
  id: string;
  kind: string;
  amount: number;
  reason: string | null;
  createdAt: string;
  createdByUserId: string;
}
interface SnapshotShape {
  regularHours: number;
  overtimeHours: number;
  grossAmount: number;
  commissionGrossSales: number;
  commissionReturnedValue: number;
  commissionAmount: number;
  adjustments: AdjustmentSnapshot[];
  adjustmentsTotal: number;
  netAmount: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  warnings: SnapshotWarning[];
  baseEarnings: number;
  hourlyEarnings: number;
  commissionRate: number;
}
interface SheetView {
  employeeId: string;
  employeeName: string | null;
  role: string;
  lifecycle: Lifecycle;
  periodId: string | null;
  periodStart: string;
  periodEnd: string;
  snapshot: SnapshotShape;
  compensationSnapshot: {
    payType: "fixed" | "hourly" | "hybrid";
    baseSalaryMonthly: number | null;
    hourlyRate: number | null;
    commissionRate: number;
    bonusEligible: boolean;
  } | null;
  finalizedAt: string | null;
  voidedAt: string | null;
}

interface Props {
  employeeId: string;
  month: string;
  isOpen: boolean;
  onClose: () => void;
  onToast: (t: { type: "success" | "error"; message: string }) => void;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `−${abs}` : abs;
}

export function PayrollEmployeeDetail({ employeeId, month, isOpen, onClose, onToast }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ sheet: SheetView }>({
    queryKey: ["payroll-sheet", employeeId, month],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/employee/${employeeId}/${month}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: isOpen,
  });

  const sheet = data?.sheet;
  const isFinalized = sheet?.lifecycle === "FINALIZED" || sheet?.lifecycle === "VOIDED";

  const [kind, setKind] = useState<"bonus" | "deduction">("bonus");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const createAdjustment = useMutation({
    mutationFn: async () => {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt === 0) throw new Error("Amount required");
      const signed = kind === "bonus" ? Math.abs(amt) : -Math.abs(amt);
      const res = await fetch("/api/payroll/adjustments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employeeId, month, kind, amount: signed, reason: reason || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      onToast({ type: "success", message: "Adjustment added." });
      setAmount("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["payroll-sheet", employeeId, month] });
      qc.invalidateQueries({ queryKey: ["payroll", month] });
    },
    onError: (e: Error) => onToast({ type: "error", message: e.message }),
  });

  const voidAdjustment = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/payroll/adjustments/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      onToast({ type: "success", message: "Adjustment removed." });
      qc.invalidateQueries({ queryKey: ["payroll-sheet", employeeId, month] });
      qc.invalidateQueries({ queryKey: ["payroll", month] });
    },
    onError: (e: Error) => onToast({ type: "error", message: e.message }),
  });

  const downloadStatementPdf = () => {
    const url = `/api/payroll/pdf?month=${encodeURIComponent(month)}&employeeId=${encodeURIComponent(employeeId)}`;
    window.open(url, "_blank");
  };

  const title = sheet
    ? `${sheet.employeeName ?? sheet.employeeId.slice(0, 8)} — ${month}`
    : `Loading…`;

  const kv = (key: string, value: string, highlight = false) => (
    <div className={`flex items-center justify-between gap-3 ${highlight ? "border-t border-border-default pt-2 mt-1" : ""}`}>
      <span className="text-xs text-text-secondary">{key}</span>
      <span className={`tabular-nums ${highlight ? "text-base font-semibold text-text-primary" : "text-sm text-text-primary"}`}>
        {value}
      </span>
    </div>
  );

  const warnings = sheet?.snapshot.warnings ?? [];

  const adjustments = useMemo(
    () => sheet?.snapshot.adjustments ?? [],
    [sheet?.snapshot.adjustments],
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} className="max-w-2xl">
      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      )}
      {sheet && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-text-secondary">Status</div>
              <div className="text-sm font-semibold text-text-primary">{sheet.lifecycle}</div>
              {sheet.finalizedAt && (
                <div className="text-xs text-text-secondary">
                  Finalized on {new Date(sheet.finalizedAt).toLocaleDateString()}
                </div>
              )}
            </div>
            <Button variant="secondary" size="sm" onClick={downloadStatementPdf}>
              <Download className="w-3 h-3" />
              Statement PDF
            </Button>
          </div>

          {warnings.length > 0 && (
            <div className="rounded-md border border-warning-500 bg-warning-100/60 p-3">
              <div className="text-xs font-medium text-warning-700 flex items-center gap-1 mb-1">
                <AlertTriangle className="w-3 h-3" />
                {warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}
              </div>
              <ul className="list-disc ps-4 text-xs text-warning-700 space-y-0.5">
                {warnings.map((w, i) => (
                  <li key={`${w.code}-${i}`}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Compensation (effective at period start) */}
          <section className="space-y-1">
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Compensation</h3>
            {sheet.compensationSnapshot ? (
              <>
                {kv("Pay type", sheet.compensationSnapshot.payType)}
                {sheet.compensationSnapshot.baseSalaryMonthly != null &&
                  kv("Base (monthly)", fmtMoney(sheet.compensationSnapshot.baseSalaryMonthly))}
                {sheet.compensationSnapshot.hourlyRate != null &&
                  kv("Hourly rate", fmtMoney(sheet.compensationSnapshot.hourlyRate))}
                {sheet.compensationSnapshot.commissionRate > 0 &&
                  kv("Commission", `${sheet.compensationSnapshot.commissionRate}%`)}
              </>
            ) : (
              <p className="text-xs text-text-secondary">No compensation row at period start.</p>
            )}
          </section>

          {/* Attendance */}
          <section className="space-y-1">
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Attendance</h3>
            {kv("Regular hours", sheet.snapshot.regularHours.toFixed(1))}
            {kv("Overtime hours", sheet.snapshot.overtimeHours.toFixed(1))}
            {sheet.snapshot.paidLeaveDays > 0 && kv("Paid leave (days)", String(sheet.snapshot.paidLeaveDays))}
            {sheet.snapshot.unpaidLeaveDays > 0 && kv("Unpaid leave (days)", String(sheet.snapshot.unpaidLeaveDays))}
          </section>

          {/* Earnings */}
          <section className="space-y-1">
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Earnings</h3>
            {sheet.snapshot.baseEarnings > 0 && kv("Base", fmtMoney(sheet.snapshot.baseEarnings))}
            {sheet.snapshot.hourlyEarnings > 0 && kv("Hourly", fmtMoney(sheet.snapshot.hourlyEarnings))}
            {kv("Gross", fmtMoney(sheet.snapshot.grossAmount))}
            {sheet.snapshot.commissionGrossSales > 0 && (
              <>
                {kv("Sales (gross)", fmtMoney(sheet.snapshot.commissionGrossSales))}
                {sheet.snapshot.commissionReturnedValue > 0 &&
                  kv("Returns", `−${fmtMoney(sheet.snapshot.commissionReturnedValue)}`)}
                {kv("Commission", fmtMoney(sheet.snapshot.commissionAmount))}
              </>
            )}
          </section>

          {/* Adjustments */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                Adjustments
              </h3>
              <span className="text-sm tabular-nums font-medium">
                {fmtMoney(sheet.snapshot.adjustmentsTotal)}
              </span>
            </div>
            {adjustments.length === 0 && (
              <p className="text-xs text-text-secondary">No bonuses or deductions this month.</p>
            )}
            {adjustments.length > 0 && (
              <ul className="space-y-1">
                {adjustments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0">
                      <span className={a.amount >= 0 ? "text-success-600" : "text-danger-500"}>
                        {a.amount >= 0 ? "+" : "−"}
                        {Math.abs(a.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </span>
                      <span className="text-text-secondary"> · {a.kind}</span>
                      {a.reason && (
                        <span className="text-text-secondary"> — {a.reason}</span>
                      )}
                    </span>
                    {!isFinalized && (
                      <button
                        className="text-xs text-danger-500 hover:text-danger-700"
                        onClick={() => voidAdjustment.mutate(a.id)}
                        disabled={voidAdjustment.isPending}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {!isFinalized && (
              <div className="rounded-md border border-border-default bg-surface-tint/50 p-3 space-y-2">
                <div className="text-xs font-medium text-text-primary">
                  Add bonus or deduction
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as "bonus" | "deduction")}
                    className="h-9 rounded-md border border-border-default bg-surface-default px-2 text-sm"
                  >
                    <option value="bonus">Bonus</option>
                    <option value="deduction">Deduction</option>
                  </select>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Amount"
                    className="w-32"
                  />
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason (optional)"
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    onClick={() => createAdjustment.mutate()}
                    disabled={createAdjustment.isPending || !amount}
                  >
                    Add
                  </Button>
                </div>
              </div>
            )}

            {isFinalized && (
              <p className="text-xs text-text-secondary">
                This sheet is {sheet.lifecycle.toLowerCase()}; adjustments can&apos;t be edited.
                Void the sheet from the register to redo this month.
              </p>
            )}
          </section>

          {/* Net */}
          <section className="pt-2 border-t border-border-default">
            {kv("Net salary", fmtMoney(sheet.snapshot.netAmount), true)}
          </section>
        </div>
      )}
    </Modal>
  );
}
