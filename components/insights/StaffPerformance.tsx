"use client";

import { useEffect, useState } from "react";
import { UsersGroup, RotateCcw, ShoppingCart, AlertCircle } from "@/lib/icons";
import { formatPrice } from "@/lib/utils";

interface StaffStat {
  userId: string;
  name: string;
  salesCount: number;
  salesRevenue: number;
  returnsCount: number;
}

type Range = "30d" | "7d" | "90d";

const RANGE_LABELS: Record<Range, string> = {
  "7d": "7 أيام",
  "30d": "30 يوم",
  "90d": "90 يوم",
};

const RANGE_DAYS: Record<Range, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export function StaffPerformance() {
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<StaffStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const to = new Date();
        const from = new Date(Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
        const params = new URLSearchParams({
          from: from.toISOString(),
          to: to.toISOString(),
        });
        const res = await fetch(`/api/insights/staff-performance?${params}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setData([]);
          return;
        }
        const json: { data: StaffStat[] } = await res.json();
        if (!cancelled) setData(json.data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [range]);

  const totalRevenue = data.reduce((s, d) => s + d.salesRevenue, 0);
  const maxRevenue = Math.max(1, ...data.map((d) => d.salesRevenue));
  const knownData = data.filter((d) => d.userId !== "__unattributed__");
  const unattributed = data.find((d) => d.userId === "__unattributed__");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
          <UsersGroup className="w-5 h-5 text-accent" />
          أداء الموظفين
        </h2>
        <div className="flex items-center gap-1 bg-bg-card border border-border rounded-xl p-1">
          {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                range === r
                  ? "bg-white text-text-primary shadow-sm"
                  : "text-text-secondary"
              }`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-12">جاري التحميل…</p>
      ) : knownData.length === 0 && !unattributed ? (
        <div className="bg-white rounded-2xl border border-border py-12 text-center">
          <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-accent-light text-accent flex items-center justify-center">
            <UsersGroup className="w-7 h-7" />
          </div>
          <p className="text-sm font-medium text-text-primary mb-1">
            لا توجد بيانات في هذه الفترة
          </p>
          <p className="text-xs text-text-secondary">
            ستظهر الأرقام عند تسجيل أول مبيعة من قبل أحد الموظفين.
          </p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-2xl border border-border p-4">
              <p className="text-xs text-text-secondary">عدد الموظفين النشطين</p>
              <p className="text-2xl font-bold mt-1 text-text-primary">
                {knownData.length}
              </p>
            </div>
            <div className="bg-white rounded-2xl border border-border p-4">
              <p className="text-xs text-text-secondary">إجمالي المبيعات</p>
              <p className="text-2xl font-bold mt-1 text-text-primary">
                {formatPrice(totalRevenue)}
              </p>
            </div>
            <div className="bg-white rounded-2xl border border-border p-4">
              <p className="text-xs text-text-secondary">عدد العمليات</p>
              <p className="text-2xl font-bold mt-1 text-text-primary">
                {data.reduce((s, d) => s + d.salesCount, 0)}
              </p>
            </div>
          </div>

          {/* Leaderboard */}
          <div className="bg-white rounded-2xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-bg-main/40">
              <h3 className="text-sm font-semibold text-text-primary">
                ترتيب الموظفين
              </h3>
            </div>
            <ul className="divide-y divide-border">
              {knownData.map((s, idx) => {
                const widthPct = (s.salesRevenue / maxRevenue) * 100;
                const tones = [
                  "bg-accent text-white",
                  "bg-accent-light text-accent",
                  "bg-orange-100 text-orange-700",
                ];
                const rankTone = tones[idx] ?? "bg-gray-100 text-text-secondary";
                return (
                  <li key={s.userId} className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <span
                        className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${rankTone}`}
                      >
                        {idx + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <p className="font-medium text-text-primary truncate">
                            {s.name}
                          </p>
                          <p className="text-sm font-bold text-text-primary shrink-0">
                            {formatPrice(s.salesRevenue)}
                          </p>
                        </div>
                        <div className="h-2 bg-bg-main rounded-full overflow-hidden">
                          <div
                            className="h-full bg-accent rounded-full transition-all duration-500"
                            style={{ width: `${widthPct}%` }}
                          />
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-text-secondary">
                          <span className="inline-flex items-center gap-1">
                            <ShoppingCart className="w-3 h-3" />
                            {s.salesCount} عملية
                          </span>
                          {s.returnsCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-danger">
                              <RotateCcw className="w-3 h-3" />
                              {s.returnsCount} مرتجع
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Unattributed sales notice */}
          {unattributed && unattributed.salesCount > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-orange-700 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-orange-900">
                  مبيعات بدون موظف معروف
                </p>
                <p className="text-xs text-orange-700 mt-0.5">
                  {unattributed.salesCount} عملية بقيمة{" "}
                  {formatPrice(unattributed.salesRevenue)} لم يكن لها موظف
                  مسجِّل (عمليات قديمة قبل تفعيل هذه الميزة).
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
