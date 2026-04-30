"use client";

import { ChevronRight, ChevronLeft } from "lucide-react";

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  if (total <= pageSize && page === 1) return null;

  return (
    <div className="flex items-center justify-between flex-wrap gap-2 px-2 py-2 text-sm">
      <span className="text-text-secondary">
        {start}–{end} من {total}
      </span>
      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="px-2 py-1 rounded-lg border border-border bg-white text-sm"
          >
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n} / صفحة
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page === 1}
          className="p-1.5 rounded-lg border border-border bg-white disabled:opacity-40"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <span>
          {page} / {totalPages}
        </span>
        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="p-1.5 rounded-lg border border-border bg-white disabled:opacity-40"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
