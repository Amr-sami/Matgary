"use client";

import type { Return } from "@/lib/types";
import { ReturnsTableRow } from "./ReturnsTableRow";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface ReturnsTableProps {
  returns: Return[];
}

export function ReturnsTable({ returns }: ReturnsTableProps) {
  const t = useDictionary().app.returns.table;
  return (
    <div className="bg-white rounded-xl shadow-sm border border-border overflow-x-auto">
      <table className="w-full min-w-[600px]">
        <thead>
          <tr className="text-sm text-text-secondary border-b border-border bg-gray-50">
            <th className="text-start pb-3 px-4 py-3">{t.date}</th>
            <th className="text-start pb-3 px-4 py-3">{t.product}</th>
            <th className="text-start pb-3 px-4 py-3">{t.quantity}</th>
            <th className="text-start pb-3 px-4 py-3">{t.reason}</th>
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