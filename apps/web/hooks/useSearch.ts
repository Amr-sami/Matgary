"use client";

import { useState, useMemo } from "react";

export function useSearch<T>(items: T[], keys: (keyof T)[]) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((item) =>
      keys.some((key) => {
        const value = item[key];
        if (Array.isArray(value)) {
          return value.some((v) => String(v ?? "").toLowerCase().includes(q));
        }
        return String(value ?? "").toLowerCase().includes(q);
      })
    );
  }, [query, items, keys]);

  return { query, setQuery, filtered };
}