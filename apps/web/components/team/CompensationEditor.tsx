"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Save,
  History,
  Wallet,
  Download,
  TrendingUp,
  AlertCircle,
} from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/config";

type Toast = { type: "success" | "error"; message: string };
type PayType = "fixed" | "hourly" | "hybrid";

interface Member {
  userId: string;
  username: string;
  displayName: string;
  role: string;
}

interface CompensationRow {
  id: string;
  payType: PayType;
  baseSalaryMonthly: number | null;
  hourlyRate: number | null;
  standardMonthlyHours: number | null;
  effectiveFrom: string;
}

interface Props {
  onToast: (t: Toast) => void;
}

export function CompensationEditor({ onToast }: Props) {
  const dict = useDictionary();
  const t = dict.app.team.compensation;
  const { data: session } = useSession();
  const isOwner = session?.user?.role === "owner";

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/team", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) {
          setMembers([]);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const json: { data: Member[] } = await res.json();
      setMembers(json.data.filter((m) => m.role !== "owner"));
    } catch (e) {
      onToast({
        type: "error",
        message: e instanceof Error ? e.message : t.toast.loadFailed,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOwner) refresh();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);

  if (!isOwner) {
    return (
      <div className="bg-white rounded-xl border border-border p-5 text-center text-text-secondary">
        {t.ownerOnly}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-border p-8 text-center text-text-secondary">
        {t.loading}
      </div>
    );
  }

  if (members.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-border p-8 text-center">
        <Wallet className="w-8 h-8 text-text-secondary mx-auto mb-2" />
        <p className="text-text-secondary text-sm">
          {t.empty}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PeriodSummary onToast={onToast} />

      <div className="bg-white rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <Wallet className="w-5 h-5 text-accent" />
          <h3 className="font-bold text-base">{t.listHeading}</h3>
        </div>
        <ul>
          {members.map((m) => (
            <li key={m.userId} className="border-b border-border last:border-0">
              <MemberRow
                member={m}
                isOpen={openId === m.userId}
                onToggle={() =>
                  setOpenId(openId === m.userId ? null : m.userId)
                }
                onToast={onToast}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Current-month gross summary card with CSV export
// ─────────────────────────────────────────────────────────────────────────────

interface PeriodGrossDto {
  regularHours: number;
  overtimeHours: number;
  reviewCount: number;
  grossAmount: number;
  notes: string[];
}

function monthBounds(d: Date, locale: Locale): { from: string; to: string; label: string } {
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    label: start.toLocaleDateString(locale === "en" ? "en-EG" : "ar-EG", {
      month: "long",
      year: "numeric",
      numberingSystem: "latn",
    } as Intl.DateTimeFormatOptions),
  };
}

function PeriodSummary({ onToast }: { onToast: (t: Toast) => void }) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.team.compensation;
  const tp = t.period;
  const [members, setMembers] = useState<Member[]>([]);
  const [grossById, setGrossById] = useState<Record<string, PeriodGrossDto>>({});
  const [loading, setLoading] = useState(true);
  const period = monthBounds(new Date(), locale);

  const refresh = async () => {
    setLoading(true);
    try {
      const teamRes = await fetch("/api/team", { cache: "no-store" });
      if (!teamRes.ok) throw new Error(t.toast.loadTeamFailed);
      const teamJson: { data: Member[] } = await teamRes.json();
      const staff = teamJson.data.filter((m) => m.role !== "owner");
      setMembers(staff);

      const results = await Promise.all(
        staff.map(async (m) => {
          const res = await fetch(
            `/api/attendance/payroll/${m.userId}?from=${period.from}&to=${period.to}`,
            { cache: "no-store" },
          );
          if (!res.ok) return [m.userId, null] as const;
          const json = await res.json();
          return [m.userId, json.gross as PeriodGrossDto] as const;
        }),
      );
      const map: Record<string, PeriodGrossDto> = {};
      for (const [id, g] of results) if (g) map[id] = g;
      setGrossById(map);
    } catch (e) {
      onToast({
        type: "error",
        message: e instanceof Error ? e.message : t.toast.loadFailed,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = Object.values(grossById).reduce(
    (sum, g) => sum + g.grossAmount,
    0,
  );
  const totalReview = Object.values(grossById).reduce(
    (sum, g) => sum + g.reviewCount,
    0,
  );

  const exportCsv = () => {
    const url = `/api/attendance/payroll/export?from=${period.from}&to=${period.to}`;
    window.location.href = url;
  };

  return (
    <div className="bg-accent-light/30 border border-accent-light rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-accent" />
          <h3 className="font-bold text-base">
            {tp.heading.replace("{label}", period.label)}
          </h3>
        </div>
        <Button
          variant="secondary"
          onClick={exportCsv}
          disabled={members.length === 0}
          className="text-xs gap-1.5 px-3 py-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          {tp.exportCsv}
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-4">
          {tp.loading}
        </p>
      ) : members.length === 0 ? (
        <p className="text-sm text-text-secondary text-center py-2">
          {tp.noStaff}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label={tp.stats.headcount} value={members.length.toString()} />
            <Stat
              label={tp.stats.grossTotal}
              value={formatCurrency(total, locale)}
              accent
            />
            <Stat
              label={tp.stats.regularHours}
              value={Object.values(grossById)
                .reduce((s, g) => s + g.regularHours, 0)
                .toFixed(1)}
            />
            <Stat
              label={tp.stats.overtimeHours}
              value={Object.values(grossById)
                .reduce((s, g) => s + g.overtimeHours, 0)
                .toFixed(1)}
            />
          </div>
          {totalReview > 0 && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-warning/10 border border-warning/30">
              <AlertCircle
                className="w-4 h-4 text-warning shrink-0 mt-0.5"
                weight="fill"
              />
              <p
                className="text-xs text-text-primary leading-relaxed"
                dangerouslySetInnerHTML={{
                  __html: tp.reviewNotice.replace("{n}", String(totalReview)),
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-white rounded-lg border border-border p-3">
      <p className="text-[11px] text-text-secondary mb-0.5">{label}</p>
      <p
        className={`font-display font-bold text-lg ${accent ? "text-accent" : "text-text-primary"}`}
      >
        {value}
      </p>
    </div>
  );
}

function summarizeCompensation(
  c: CompensationRow,
  locale: Locale,
  t: { fixed: string; hourly: string; hybrid: string },
): string {
  if (c.payType === "fixed") {
    return t.fixed.replace("{amount}", formatCurrency(c.baseSalaryMonthly ?? 0, locale));
  }
  if (c.payType === "hourly") {
    return t.hourly.replace("{amount}", formatCurrency(c.hourlyRate ?? 0, locale));
  }
  return t.hybrid
    .replace("{base}", formatCurrency(c.baseSalaryMonthly ?? 0, locale))
    .replace("{hourly}", formatCurrency(c.hourlyRate ?? 0, locale));
}

function MemberRow({
  member,
  isOpen,
  onToggle,
  onToast,
}: {
  member: Member;
  isOpen: boolean;
  onToggle: () => void;
  onToast: (t: Toast) => void;
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.team.compensation;
  const tf = t.form;
  const ts = t.summary;
  const [history, setHistory] = useState<CompensationRow[] | null>(null);
  const current = history?.[0] ?? null;

  // Form state
  const [payType, setPayType] = useState<PayType>("fixed");
  const [baseSalary, setBaseSalary] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [standardHours, setStandardHours] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [busy, setBusy] = useState(false);

  const loadHistory = async () => {
    try {
      const res = await fetch(`/api/team/${member.userId}/compensation`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { history: CompensationRow[] } = await res.json();
      setHistory(json.history);
      // Seed form from current row so the user is editing not creating from scratch.
      const cur = json.history[0];
      if (cur) {
        setPayType(cur.payType);
        setBaseSalary(cur.baseSalaryMonthly?.toString() ?? "");
        setHourlyRate(cur.hourlyRate?.toString() ?? "");
        setStandardHours(cur.standardMonthlyHours?.toString() ?? "");
      }
    } catch (e) {
      onToast({
        type: "error",
        message: e instanceof Error ? e.message : t.toast.loadFailed,
      });
    }
  };

  useEffect(() => {
    if (isOpen && history === null) loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/team/${member.userId}/compensation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payType,
          baseSalaryMonthly: baseSalary ? Number(baseSalary) : null,
          hourlyRate: hourlyRate ? Number(hourlyRate) : null,
          standardMonthlyHours: standardHours ? Number(standardHours) : null,
          effectiveFrom: new Date(effectiveFrom).toISOString(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        onToast({ type: "error", message: json.error || t.toast.saveFailed });
        return;
      }
      await loadHistory();
      onToast({ type: "success", message: t.toast.saveSuccess });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 hover:bg-bg-main/40 transition-colors text-start"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="shrink-0 w-9 h-9 rounded-full bg-accent-light text-accent font-bold text-sm flex items-center justify-center">
            {member.displayName.charAt(0)}
          </span>
          <div className="min-w-0">
            <p className="font-medium text-text-primary truncate" dir="auto">
              {member.displayName}
            </p>
            <p className="text-xs text-text-secondary truncate">
              {current ? summarizeCompensation(current, locale, ts) : t.noCompensation}
            </p>
          </div>
        </div>
        <span className="text-xs text-text-secondary shrink-0">
          {isOpen ? t.hide : t.edit}
        </span>
      </button>

      {isOpen && (
        <div className="px-5 pb-5 space-y-4 bg-bg-main/30">
          <Select
            label={tf.payType}
            value={payType}
            onChange={(e) => setPayType(e.target.value as PayType)}
            options={[
              { value: "fixed", label: tf.payTypes.fixed },
              { value: "hourly", label: tf.payTypes.hourly },
              { value: "hybrid", label: tf.payTypes.hybrid },
            ]}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(payType === "fixed" || payType === "hybrid") && (
              <Input
                label={tf.baseSalary}
                type="number"
                inputMode="decimal"
                value={baseSalary}
                onChange={(e) => setBaseSalary(e.target.value)}
                placeholder={tf.baseSalaryPlaceholder}
              />
            )}
            {(payType === "hourly" || payType === "hybrid") && (
              <Input
                label={tf.hourlyRate}
                type="number"
                inputMode="decimal"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
                placeholder={tf.hourlyRatePlaceholder}
              />
            )}
            {payType === "hybrid" && (
              <Input
                label={tf.standardHours}
                type="number"
                inputMode="numeric"
                value={standardHours}
                onChange={(e) => setStandardHours(e.target.value)}
                placeholder={tf.standardHoursPlaceholder}
              />
            )}
            <Input
              label={tf.effectiveFrom}
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </div>

          <div className="flex justify-end">
            <Button
              onClick={submit}
              loading={busy}
              disabled={busy}
              className="flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              {tf.save}
            </Button>
          </div>

          {history && history.length > 1 && (
            <div className="pt-4 border-t border-border">
              <p className="text-xs font-medium text-text-secondary mb-2 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" />
                {tf.historyHeading}
              </p>
              <ul className="space-y-1.5">
                {history.slice(1).map((h) => (
                  <li
                    key={h.id}
                    className="text-xs text-text-secondary flex items-center justify-between gap-2"
                  >
                    <span>{summarizeCompensation(h, locale, ts)}</span>
                    <span className="shrink-0">
                      {formatDate(new Date(h.effectiveFrom), locale)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
