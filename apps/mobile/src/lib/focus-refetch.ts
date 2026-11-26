/**
 * Refetch-on-focus for screens that stay mounted (the tabs, Home above all).
 *
 * TanStack Query refetches a stale query when a NEW observer mounts or when
 * the app returns to the foreground (PushRegistrar wires focusManager to
 * AppState). A tab screen is mounted once and kept, so switching back to it
 * does neither: Home's "Transfers awaiting confirmation" card kept the count
 * it fetched before sales recorded elsewhere (another phone, the web, a
 * cashier) while the inbox, mounted fresh, showed the new one (audit T1
 * N-card: Home 4, inbox 7 a minute later; the server's two numbers agreed).
 *
 * Imports nothing, so `node --test --experimental-strip-types` loads it.
 */

/** The app-wide `staleTime` (app/_layout.tsx): what TanStack itself counts as stale. */
export const FOCUS_REFETCH_STALE_MS = 30_000;

export interface FocusQueryState {
  dataUpdatedAt: number;
  fetchStatus: "fetching" | "paused" | "idle";
}

/**
 * True when a focused screen should refetch its query: it has data (the first
 * load is the mount's job), nothing is in flight, and the data is at least
 * `staleMs` old.
 */
export function shouldRefetchOnFocus(
  state: FocusQueryState | undefined,
  now: number,
  staleMs: number = FOCUS_REFETCH_STALE_MS,
): boolean {
  if (!state || state.dataUpdatedAt <= 0) return false;
  if (state.fetchStatus !== "idle") return false;
  return now - state.dataUpdatedAt >= staleMs;
}
