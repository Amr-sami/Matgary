import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Pull-to-refresh state that a RefreshControl can trust.
 *
 * THE BUG THIS EXISTS FOR: screens used to pass `refreshing={q.isRefetching}`.
 * That flag is also true during BACKGROUND refetches — a sheet closes, its
 * mutation invalidates queries, the list refetches — so the RefreshControl was
 * shown PROGRAMMATICALLY, with no pull. On RN new-arch iOS a programmatic
 * spinner does not reliably retract when the prop flips back to false: it
 * stays visible and pushes the header ~150 px down until the next pull.
 *
 * THE RULE: `refreshing` is true only between the user's pull and the end of
 * THAT refetch. It is set by the pull, and cleared by whichever comes first:
 *   1. the promise returned by `onRefresh` settles (when it returns one), or
 *   2. `isRefetching` — the caller's query signal — goes back to false AFTER
 *      having been true for this pull, or
 *   3. a short grace window passes with neither a promise nor a true signal
 *      (the pull triggered nothing observable; never leave a spinner stuck).
 * A background refetch flipping `isRefetching` on its own never sets it.
 *
 * Why "after having been true": TanStack Query notifies observers through
 * `setTimeout(0)` (notifyManager), so on the render right after the pull the
 * query still reports `isRefetching === false`; clearing on a bare false would
 * retract the spinner before the fetch even showed up.
 *
 * Usage (a FlashList screen that owns its RefreshControl):
 *   const pull = usePullRefresh(() => q.refetch(), q.isRefetching && !q.isFetchingNextPage);
 *   <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
 * Screen.tsx applies it internally; its `refreshing` prop is the signal.
 */
export function usePullRefresh(
  onRefresh: (() => unknown) | undefined,
  isRefetching = false,
): { refreshing: boolean; onRefresh: (() => void) | undefined } {
  const [refreshing, setRefreshing] = useState(false);
  // Identifies the current pull; a promise settling from an earlier pull
  // (user pulled twice) must not clear the later one.
  const pullId = useRef(0);
  // Whether `isRefetching` has been observed true since the current pull.
  const sawFetching = useRef(false);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  // Always call the latest callback: RefreshControl holds our stable handler,
  // and screens rebuild theirs every render. Written in an effect (not during
  // render) so a bailed-out render never leaves a stale closure behind.
  const callbackRef = useRef(onRefresh);
  useEffect(() => {
    callbackRef.current = onRefresh;
  });

  const clearGrace = () => {
    if (graceTimer.current) {
      clearTimeout(graceTimer.current);
      graceTimer.current = null;
    }
  };

  const finish = useCallback((id: number) => {
    if (id !== pullId.current) return;
    clearGrace();
    sawFetching.current = false;
    if (mounted.current) setRefreshing(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearGrace();
    };
  }, []);

  // Signal-driven clearing (rule 2). Runs after every render so it sees each
  // true/false step of the caller's query flag.
  useEffect(() => {
    if (!refreshing) return;
    if (isRefetching) {
      sawFetching.current = true;
      // The pull is doing observable work; the grace window no longer applies.
      clearGrace();
      return;
    }
    if (sawFetching.current) finish(pullId.current);
  }, [refreshing, isRefetching, finish]);

  const handleRefresh = useCallback(() => {
    const cb = callbackRef.current;
    if (!cb) return;
    const id = ++pullId.current;
    sawFetching.current = false;
    clearGrace();
    setRefreshing(true);

    let result: unknown;
    try {
      result = cb();
    } catch (err) {
      finish(id);
      throw err;
    }

    if (isThenable(result)) {
      // Rule 1: the caller told us exactly when its refetch ends.
      result.then(
        () => finish(id),
        () => finish(id),
      );
      return;
    }
    // Rule 3: void callback (`() => void q.refetch()`). The query signal
    // normally goes true within a tick; if it never does, nothing is fetching
    // and the spinner must not stay up.
    graceTimer.current = setTimeout(() => {
      graceTimer.current = null;
      if (!sawFetching.current) finish(id);
    }, GRACE_MS);
  }, [finish]);

  return { refreshing, onRefresh: onRefresh ? handleRefresh : undefined };
}

/**
 * How long a pull may spin with no promise and no `isRefetching === true`
 * before we conclude it triggered nothing. Query notifications land in one
 * `setTimeout(0)` tick, so this is many times the real latency-to-signal, yet
 * short enough that a dead pull is not mistaken for a hung network.
 */
const GRACE_MS = 1500;

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}
