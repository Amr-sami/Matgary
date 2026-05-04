"use client";

import { Search, X } from "@/lib/icons";
import { useSearch } from "@/hooks/useSearch";

interface InventorySearchBarProps {
  onSearch: (query: string) => void;
}

export function InventorySearchBar({ onSearch }: InventorySearchBarProps) {
  const { query, setQuery } = { query: "", setQuery: onSearch };

  return (
    <div className="relative">
      <Search className="absolute start-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
      <input
        type="text"
        placeholder="ابحث عن منتج، براند، أو صنف..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        dir="rtl"
        className="w-full ps-12 pe-10 py-3 rounded-xl border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent"
      />
      {query && (
        <button
          onClick={() => setQuery("")}
          className="absolute end-4 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100 rounded"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}