"use client";

import { cn, getTodayRange, getYesterdayRange, getThisMonthRange } from "@/lib/utils";

interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  onRangeChange: (start: string, end: string) => void;
}

export function DateRangePicker({ startDate, endDate, onRangeChange }: DateRangePickerProps) {
  const formatDateForInput = (date: Date) => {
    return date.toISOString().split("T")[0];
  };

  const presets = [
    { label: "اليوم", getRange: getTodayRange },
    { label: "أمس", getRange: getYesterdayRange },
    { label: "هذا الشهر", getRange: getThisMonthRange },
  ];

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-border space-y-4">
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <button
            key={preset.label}
            onClick={() => {
              const { start, end } = preset.getRange();
              onRangeChange(formatDateForInput(start), formatDateForInput(end));
            }}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-50 border border-border text-text-secondary hover:bg-accent-light hover:border-accent hover:text-accent transition-all"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-secondary mr-1">من تاريخ</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => onRangeChange(e.target.value, endDate)}
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-secondary mr-1">إلى تاريخ</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => onRangeChange(startDate, e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-text-primary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors"
          />
        </div>
      </div>
    </div>
  );
}
