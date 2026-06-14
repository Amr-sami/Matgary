"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

// One QueryClient per browser tab. Created lazily inside a `useState` so
// that React strict-mode double-invocation in dev doesn't tear down and
// rebuild the cache.
//
// Default options chosen for this app:
//   staleTime: 30 s — most reads (categories, settings, branches) change
//      only when the owner mutates them. 30 s of "fresh" means co-mounted
//      consumers share a single in-memory result without any refetch.
//      Endpoints that need stricter freshness override at the useQuery
//      call site (`staleTime: 0`), not globally.
//
//   gcTime: 5 min — keep cached data alive after the last consumer
//      unmounts, so back-navigation within 5 min reuses the result
//      without a network round-trip.
//
//   retry: 1 — networking is mostly local LAN / Wi-Fi; one retry is
//      enough. Higher counts add user-visible latency on real failures.
//
//   refetchOnWindowFocus: false — POS users tab-switch constantly to
//      WhatsApp / printer apps; refetching on every focus would thrash
//      the network. Hooks that genuinely want focus-revalidation can
//      opt in per-call.
//
//   refetchOnReconnect: true — the cashier WILL lose Wi-Fi mid-shift;
//      auto-refetch when it comes back is correct.

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
