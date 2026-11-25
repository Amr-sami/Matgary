"use client";

// Payroll register — monthly sheet for the Owner.
//
// Reads /api/payroll/period/[month] and renders one row per tenant member
// with the live snapshot (or the frozen snapshot for finalized rows). Writes
// through the existing payroll APIs; never does payroll math in React.
//
// UX notes:
//   • The register BIG four states (MISSING/DRAFT/FINALIZED/VOIDED) are
//     surfaced by a status badge and row tint so the Owner can tell at a
//     glance whether numbers are draft or historical.
//   • Sticky employee column on desktop keeps the row identity visible as
//     the user scans wide money columns.
//   • Warnings for the row hang under the status badge so the Owner can see
//     "missing attendance" without drilling in.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DollarSign, CheckCircle2, Undo2, Download, AlertTriangle } from "@/lib/icons";
import { PayrollEmployeeDetail } from "./PayrollEmployeeDetail";

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
  commissionAmount: number;
  adjustments: AdjustmentSnapshot[];
  adjustmentsTotal: number;
  netAmount: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  warnings: SnapshotWarning[];
  baseEarnings: number;
  hourlyEarnings: number;
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
  finalizedAt: string | null;
  finalizedByUserId: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
}

interface Props {
  isOwner: boolean;
  onToast: (t: { type: "success" | "error"; message: string }) => void;
}

function currentMonthIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `−${abs}` : abs;
}

function lifecycleBadge(lc: Lifecycle): { label: string; className: string } {
  switch (lc) {
    case "DRAFT":
      return { label: "Draft", className: "bg-blue-100 text-blue-700" };
    case "FINALIZED":
      return { label: "Finalized", className: "bg-success-light text-success" };
    case "VOIDED":
      return { label: "Voided", className: "bg-gray-200 text-gray-600" };
    default:
      return { label: "Not started", className: "bg-gray-100 text-gray-500" };
  }
}

export function PayrollRegister({ isOwner, onToast }: Props) {
  const [month, setMonth] = useState<string>(currentMonthIso());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Lifecycle>("all");
  const [onlyWithWarnings, setOnlyWithWarnings] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState<SheetView | null>(null);
  const [detailEmployeeId, setDetailEmployeeId] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data, isLoading, isError } = useQuery<{ rows: SheetView[] }>({
    queryKey: ["payroll", month],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/period/${month}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows = data?.rows ?? [];
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (search && !(r.employeeName ?? "").toLowerCase().includes(search.toLowerCase())) return false;
      if (statusFilter !== "all" && r.lifecycle !== statusFilter) return false;
      if (onlyWithWarnings && r.snapshot.warnings.length === 0) return false;
      return true;
    });
  }, [rows, search, statusFilter, onlyWithWarnings]);

  const totals = useMemo(() => {
    let base = 0;
    let hourly = 0;
    let ot = 0;
    let sales = 0;
    let commission = 0;
    let bonus = 0;
    let deductions = 0;
    let net = 0;
    for (const r of filteredRows) {
      if (r.lifecycle === "VOIDED") continue;
      const s = r.snapshot;
      base += s.baseEarnings;
      hourly += s.hourlyEarnings;
      ot += s.overtimeHours;
      sales += s.commissionGrossSales;
      commission += s.commissionAmount;
      for (const a of s.adjustments) {
        if (a.amount >= 0) bonus += a.amount;
        else deductions += a.amount;
      }
      if (s.adjustments.length === 0 && s.adjustmentsTotal !== 0) {
        if (s.adjustmentsTotal >= 0) bonus += s.adjustmentsTotal;
        else deductions += s.adjustmentsTotal;
      }
      net += s.netAmount;
    }
    return { base, hourly, ot, sales, commission, bonus, deductions, net };
  }, [filteredRows]);

  const calculate = useMutation({
    mutationFn: async (employeeId: string) => {
      const res = await fetch("/api/payroll/calculate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employeeId, month }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      onToast({ type: "success", message: "Payroll draft updated." });
      qc.invalidateQueries({ queryKey: ["payroll", month] });
    },
    onError: (e: Error) => {
      onToast({ type: "error", message: e.message });
    },
  });

  const finalize = useMutation({
    mutationFn: async (employeeId: string) => {
      const res = await fetch("/api/payroll/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employeeId, month }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      onToast({ type: "success", message: "Payroll finalized." });
      qc.invalidateQueries({ queryKey: ["payroll", month] });
    },
    onError: (e: Error) => {
      onToast({ type: "error", message: e.message });
    },
  });

  const voidSheet = useMutation({
    mutationFn: async (args: { periodId: string; reason: string }) => {
      const res = await fetch("/api/payroll/void", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      onToast({ type: "success", message: "Payroll voided." });
      qc.invalidateQueries({ queryKey: ["payroll", month] });
      setConfirmVoid(null);
    },
    onError: (e: Error) => {
      onToast({ type: "error", message: e.message });
    },
  });

  const downloadRegisterPdf = () => {
    const url = `/api/payroll/pdf?month=${encodeURIComponent(month)}`;
    window.open(url, "_blank");
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="h-9 rounded-md border border-border-default bg-surface-default px-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Search</label>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Employee name…"
            className="h-9 w-56 rounded-md border border-border-default bg-surface-default px-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="h-9 rounded-md border border-border-default bg-surface-default px-2 text-sm text-text-primary"
          >
            <option value="all">All</option>
            <option value="MISSING">Not started</option>
            <option value="DRAFT">Draft</option>
            <option value="FINALIZED">Finalized</option>
            <option value="VOIDED">Voided</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={onlyWithWarnings}
            onChange={(e) => setOnlyWithWarnings(e.target.checked)}
          />
          Warnings only
        </label>
        <div className="ms-auto">
          <Button
            variant="secondary"
            size="sm"
            onClick={downloadRegisterPdf}
            disabled={rows.length === 0 || isLoading}
          >
            <Download className="w-4 h-4" />
            Download register PDF
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-md border border-border-default">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-tint text-xs uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="sticky start-0 bg-surface-tint px-3 py-2 text-start">Employee</th>
              <th className="px-3 py-2 text-start">Status</th>
              <th className="px-3 py-2 text-end">Base</th>
              <th className="px-3 py-2 text-end">Hourly</th>
              <th className="px-3 py-2 text-end">OT hrs</th>
              <th className="px-3 py-2 text-end">Sales</th>
              <th className="px-3 py-2 text-end">Commission</th>
              <th className="px-3 py-2 text-end">Bonus</th>
              <th className="px-3 py-2 text-end">Deductions</th>
              <th className="px-3 py-2 text-end">Net</th>
              <th className="px-3 py-2 text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={11} className="p-6">
                  <Skeleton className="h-10 w-full" />
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={11} className="p-6 text-center text-danger-500 text-sm">
                  Failed to load register. Try again.
                </td>
              </tr>
            )}
            {!isLoading && !isError && filteredRows.length === 0 && (
              <tr>
                <td colSpan={11} className="p-6 text-center text-text-secondary text-sm">
                  {search || statusFilter !== "all" || onlyWithWarnings
                    ? "No rows match this filter."
                    : "No employees for this month yet."}
                </td>
              </tr>
            )}
            {filteredRows.map((row) => {
              const s = row.snapshot;
              const bonusPart = s.adjustments.filter((a) => a.amount >= 0).reduce((t, a) => t + a.amount, 0);
              const dedPart = s.adjustments.filter((a) => a.amount < 0).reduce((t, a) => t + a.amount, 0);
              const effBonus =
                s.adjustments.length === 0 && s.adjustmentsTotal >= 0 ? s.adjustmentsTotal : bonusPart;
              const effDed =
                s.adjustments.length === 0 && s.adjustmentsTotal < 0 ? s.adjustmentsTotal : dedPart;
              const badge = lifecycleBadge(row.lifecycle);
              const voided = row.lifecycle === "VOIDED";
              return (
                <tr
                  key={row.employeeId}
                  className={voided ? "opacity-60" : ""}
                >
                  <td className="sticky start-0 bg-surface-default px-3 py-2 border-t border-border-default font-medium text-text-primary">
                    <button
                      type="button"
                      className="text-start hover:underline text-text-primary"
                      onClick={() => setDetailEmployeeId(row.employeeId)}
                    >
                      {row.employeeName ?? row.employeeId.slice(0, 8)}
                    </button>
                    <div className="text-xs text-text-secondary">{row.role}</div>
                  </td>
                  <td className="px-3 py-2 border-t border-border-default">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${badge.className}`}>
                      {badge.label}
                    </span>
                    {s.warnings.length > 0 && (
                      <div className="mt-1 text-xs text-warning-600 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        {s.warnings.length === 1
                          ? s.warnings[0]!.message
                          : `${s.warnings.length} warnings`}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 border-t border-border-default text-end tabular-nums">
                    {fmtMoney(s.baseEarnings)}
                  </td>
                  <td className="px-3 py-2 border-t border-border-default text-end tabular-nums">
                    {fmtMoney(s.hourlyEarnings)}
                  </td>
                  <td className="px-3 py-2 border-t border-border-default text-end tabular-nums">
                    {s.overtimeHours.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 border-t border-border-default text-end tabular-nums">
                    {fmtMoney(s.commissionGrossSales)}
                  </td>
                  <td className="px-3 py-2 border-t border-border-default text-end tabular-nums">
                    {fmtMoney(s.commissionAmount)}
                  </td>
                  <td className="px-3 py-2 border-t border-border-default text-end tabular-nums text-success-600">
                    {fmtMoney(effBonus)}
                  </td>
                  <td className="px-3 py-2 border-t border-border-default text-end tabular-nums text-danger-500">
                    {fmtMoney(effDed)}
                  </td>
                  <td className="px-3 py-2 border-t border-border-default text-end tabular-nums font-semibold">
                    {fmtMoney(s.netAmount)}
                  </td>
                  <td className="px-3 py-2 border-t border-border-default text-end">
                    <div className="flex items-center justify-end gap-1">
                      {row.lifecycle !== "FINALIZED" && !voided && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => calculate.mutate(row.employeeId)}
                          disabled={calculate.isPending}
                        >
                          <DollarSign className="w-3 h-3" />
                          Calc
                        </Button>
                      )}
                      {isOwner && row.lifecycle !== "FINALIZED" && !voided && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => finalize.mutate(row.employeeId)}
                          disabled={finalize.isPending || s.warnings.some((w) => w.code === "no_compensation")}
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Finalize
                        </Button>
                      )}
                      {isOwner && row.lifecycle === "FINALIZED" && row.periodId && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setConfirmVoid(row)}
                          disabled={voidSheet.isPending}
                        >
                          <Undo2 className="w-3 h-3" />
                          Void
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {filteredRows.length > 0 && (
            <tfoot className="bg-surface-tint">
              <tr>
                <td className="sticky start-0 bg-surface-tint px-3 py-2 font-medium text-text-primary">
                  Totals
                </td>
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2 text-end font-medium tabular-nums">
                  {fmtMoney(totals.base)}
                </td>
                <td className="px-3 py-2 text-end font-medium tabular-nums">
                  {fmtMoney(totals.hourly)}
                </td>
                <td className="px-3 py-2 text-end font-medium tabular-nums">
                  {totals.ot.toFixed(1)}
                </td>
                <td className="px-3 py-2 text-end font-medium tabular-nums">
                  {fmtMoney(totals.sales)}
                </td>
                <td className="px-3 py-2 text-end font-medium tabular-nums">
                  {fmtMoney(totals.commission)}
                </td>
                <td className="px-3 py-2 text-end font-medium tabular-nums text-success-600">
                  {fmtMoney(totals.bonus)}
                </td>
                <td className="px-3 py-2 text-end font-medium tabular-nums text-danger-500">
                  {fmtMoney(totals.deductions)}
                </td>
                <td className="px-3 py-2 text-end font-semibold tabular-nums">
                  {fmtMoney(totals.net)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {detailEmployeeId && (
        <PayrollEmployeeDetail
          employeeId={detailEmployeeId}
          month={month}
          isOpen={detailEmployeeId !== null}
          onClose={() => setDetailEmployeeId(null)}
          onToast={onToast}
        />
      )}

      <ConfirmDialog
        isOpen={confirmVoid !== null}
        title="Void finalized payroll?"
        message={`Voiding ${confirmVoid?.employeeName ?? "this employee"}'s sheet for ${month} removes it from the P&L and lets you recalculate. The voided row stays on record.`}
        confirmText="Void"
        variant="danger"
        loading={voidSheet.isPending}
        onConfirm={() => {
          if (!confirmVoid?.periodId) return;
          voidSheet.mutate({
            periodId: confirmVoid.periodId,
            reason: "Owner void from register",
          });
        }}
        onClose={() => setConfirmVoid(null)}
      />
    </div>
  );
}
