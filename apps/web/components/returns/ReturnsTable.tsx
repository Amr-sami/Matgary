"use client";

import type { Return } from "@/lib/types";
import { ReturnsTableRow } from "./ReturnsTableRow";

interface ReturnsTableProps {
  returns: Return[];
}

export function ReturnsTable({ returns }: ReturnsTableProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-border overflow-x-auto">
      <table className="w-full min-w-[600px]">
        <thead>
          <tr className="text-sm text-text-secondary border-b border-border bg-gray-50">
            <th className="text-start pb-3 px-4 py-3">التاريخ</th>
            <th className="text-start pb-3 px-4 py-3">المنتج</th>
            <th className="text-start pb-3 px-4 py-3">الكمية المرتجعة</th>
            <th className="text-start pb-3 px-4 py-3">سبب الإرجاع</th>
          </tr>
        </thead>
        <tbody>
          {returns.map((ret) => (
            <ReturnsTableRow key={ret.id} returnRecord={ret} />
          ))}
        </tbody>
      </table>
    </div>
  );
}