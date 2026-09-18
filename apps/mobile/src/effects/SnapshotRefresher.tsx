import { useEffect, useRef } from "react";
import { InteractionManager } from "react-native";
import { useQueryClient } from "@tanstack/react-query";

import { HYDRATE_FIRST, hydrateFromSnapshots, snapshotIO } from "@/offline/hydrate";
import { attachSnapshotSubscriber, isSnapshotKey, type SnapshotSubscriber } from "@/offline/snapshot";
import { useOffline } from "@/stores/offline";
import { useSession } from "@/stores/session";

/**
 * The read path's lifecycle (doc 06 §6.2). Mounted once by <AppEffects/>
 * inside QueryClientProvider; renders nothing. The QueryClient in
 * app/_layout.tsx is a module-local const, not an export, so it is taken
 * from the provider here.
 *
 *  - signedIn:   hydrate the cache from SQLite once (per signed-in session) —
 *                the POS roots synchronously, the rest after interactions —
 *                then start copying successful fetches back to SQLite.
 *  - signedOut:  detach (flushing first) and CLEAR the QueryClient. The
 *                engine wipes the table itself; the in-memory cache is ours.
 *                Hydrated roots live 24h past their last observer, so without
 *                this the next account on a shared tablet would inherit the
 *                previous shop's catalogue and customers (doc 06 §5.5), and
 *                hydration's "already has data → skip" would keep it there.
 *  - reconnect:  offline → online flips invalidate every snapshotted key so
 *                whatever is on screen refreshes; inactive ones go stale and
 *                refetch on their next mount.
 *  - /me:        the session store caches its own last good /me (that is
 *                what lets an offline cold start reach here at all). While
 *                `session.offline` is set the copy is unconfirmed, so the
 *                first moment we are online it is re-read.
 */
export function SnapshotRefresher() {
  const queryClient = useQueryClient();
  const status = useSession((s) => s.status);
  const restored = useSession((s) => s.offline);
  const online = useOffline((s) => s.online);
  const subscriber = useRef<SnapshotSubscriber | null>(null);
  const prevOnline = useRef<boolean | null>(null);

  // Hydrate + attach on every signedOut→signedIn edge; detach + clear on the way out.
  useEffect(() => {
    if (status !== "signedIn") return;
    let cancelled = false;
    try {
      hydrateFromSnapshots(queryClient, snapshotIO, { only: HYDRATE_FIRST });
    } catch {
      // No table yet, or a corrupt row: the screens fetch as they always did.
    }
    const rest = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      try {
        hydrateFromSnapshots(queryClient, snapshotIO, { except: HYDRATE_FIRST });
      } catch {
        /* same */
      }
    });
    const sub = attachSnapshotSubscriber(queryClient, snapshotIO);
    subscriber.current = sub;
    return () => {
      cancelled = true;
      rest.cancel();
      subscriber.current = null;
      sub.detach();
      // Every query, not only the snapshotted roots: insights, activity and
      // notifications are the previous account's too.
      queryClient.clear();
    };
  }, [status, queryClient]);

  // A session restored from the cached /me is confirmed the first moment we
  // are online. Failure leaves `offline` set, so this does not loop: it runs
  // again only on the next connectivity edge. A fatal answer signs out via
  // the client's onSessionLost.
  useEffect(() => {
    if (status !== "signedIn" || !restored || !online) return;
    void useSession
      .getState()
      .refreshMe()
      .catch(() => {});
  }, [status, restored, online]);

  // Reconnect → refresh the last-good answers.
  useEffect(() => {
    const was = prevOnline.current;
    prevOnline.current = online;
    if (online && was === false && status === "signedIn") {
      void queryClient.invalidateQueries({ predicate: (q) => isSnapshotKey(q.queryKey) });
    }
  }, [online, status, queryClient]);

  return null;
}
