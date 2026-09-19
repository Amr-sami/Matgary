/**
 * DEV-ONLY "Simulate offline" (the /sync switch; the e2e offline-sale.yaml
 * flips it). Never ships: every consumer guards with `__DEV__`, and in a
 * release bundle `isSimulatedOffline()` is a constant `false` that Metro's
 * dead-code elimination folds away along with the switch.
 *
 * What it does when on:
 *  - `useOffline.online` is forced to false (see <OfflineDrainer/>, which
 *    also masks live NetInfo events while the switch is on), so
 *    outbox.drain() skips every pass and sales.tsx enqueues instead of
 *    POSTing — the same two code paths a real outage exercises;
 *  - TanStack's onlineManager is told we are offline, so query refetches
 *    pause exactly as they would with the radio off;
 *  - the "sale" outbox handler refuses to send (throws an offline ApiError),
 *    a belt-and-braces guard for a drain that was already in flight.
 * Turning it off restores NetInfo's last word — for `useOffline.online` via
 * <OfflineDrainer/>, and for onlineManager by re-reading NetInfo here, so a
 * radio that is genuinely off stays off for queries too — and fires a
 * "reconnect" drain.
 */
import NetInfo from "@react-native-community/netinfo";
import { onlineManager } from "@tanstack/react-query";
import { create } from "zustand";

interface DevOfflineState {
  simulate: boolean;
  setSimulate: (on: boolean) => void;
}

export const useDevOffline = create<DevOfflineState>((set) => ({
  simulate: false,
  setSimulate: (on) => {
    if (!__DEV__) return;
    set({ simulate: on });
    if (on) {
      onlineManager.setOnline(false);
      return;
    }
    // Off: NOT a blanket "online" — that would resume paused refetches into a
    // real outage. Ask NetInfo for its current verdict, the same test
    // app/_layout.tsx applies on every event.
    void NetInfo.fetch().then((state) => {
      if (useDevOffline.getState().simulate) return; // flipped back on meanwhile
      onlineManager.setOnline(Boolean(state.isConnected) && state.isInternetReachable !== false);
    });
  },
}));

/** True only in a dev bundle with the switch on. */
export function isSimulatedOffline(): boolean {
  return __DEV__ ? useDevOffline.getState().simulate : false;
}
