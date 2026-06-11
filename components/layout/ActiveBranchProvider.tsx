"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Lightweight context carrying the active branch name read from the
 * non-HttpOnly `mg.branch_name` cookie on the server. The Sidebar reads
 * this to render the right store name on the FIRST paint — both SSR
 * and the first client render see the same value, so there's no swap
 * or layout shift when the page finishes hydrating.
 *
 * Defaults to `null` (and the sidebar falls back to the dictionary's
 * locale-safe `storeFallback`) before the first `/api/branches` call
 * has populated the cookie. After that one network roundtrip every
 * subsequent SSR render gets the right name.
 */
const ActiveBranchNameContext = createContext<string | null>(null);

export function ActiveBranchNameProvider({
  initialName,
  children,
}: {
  initialName: string | null;
  children: ReactNode;
}) {
  return (
    <ActiveBranchNameContext.Provider value={initialName}>
      {children}
    </ActiveBranchNameContext.Provider>
  );
}

export function useActiveBranchName(): string | null {
  return useContext(ActiveBranchNameContext);
}
