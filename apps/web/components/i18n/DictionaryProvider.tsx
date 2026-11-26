"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/get-dictionary";

interface Ctx {
  locale: Locale;
  dict: Dictionary;
}

const DictionaryContext = createContext<Ctx | null>(null);

export function DictionaryProvider({
  locale,
  dict,
  children,
}: Ctx & { children: ReactNode }) {
  return (
    <DictionaryContext.Provider value={{ locale, dict }}>
      {children}
    </DictionaryContext.Provider>
  );
}

export function useDictionary(): Dictionary {
  const ctx = useContext(DictionaryContext);
  if (!ctx)
    throw new Error("useDictionary() called outside <DictionaryProvider>");
  return ctx.dict;
}

export function useLocale(): Locale {
  const ctx = useContext(DictionaryContext);
  if (!ctx) throw new Error("useLocale() called outside <DictionaryProvider>");
  return ctx.locale;
}

/**
 * Safe variants for shared UI primitives that may be mounted outside the
 * [lang] tree (e.g. logged-in `/account/security`). Returns null when no
 * provider is in scope; callers fall back to a sensible default.
 */
export function useOptionalDictionary(): Dictionary | null {
  return useContext(DictionaryContext)?.dict ?? null;
}

export function useOptionalLocale(): Locale | null {
  return useContext(DictionaryContext)?.locale ?? null;
}
