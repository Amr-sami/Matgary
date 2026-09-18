import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";

import { api } from "@/api/client";
import { drainNow, useOffline } from "@/offline";
import { useSession } from "@/stores/session";

/**
 * Every trigger that starts a drain pass (doc 06 §6.4). Mounted once by
 * <AppEffects/>; renders nothing.
 *
 *  - launch:        first mount after the session is signedIn
 *  - reconnect:     NetInfo connected && isInternetReachable !== false
 *  - foreground:    AppState → "active"
 *  - interval:      every 20s while foregrounded AND the queue is non-empty
 *  - session:       signedOut → signedIn (also lifts an auth-wait pause);
 *                   the engine itself also fires it when /me stops stating
 *                   a billing / suspension / password wall
 *  - background:    expo-background-task, ≥15 min, best effort (see below)
 *
 * Background execution is a bonus, never a guarantee: on iOS the OS picks
 * the cadence, gives ~30s, and stops entirely after a force-quit. The engine
 * must be — and is — correct on foreground drains alone.
 */

export const BACKGROUND_TASK = "thestoro-outbox-drain";
const FOREGROUND_INTERVAL_MS = 20_000;

// Defined at module scope so the task exists in the headless JS context,
// where no component ever mounts.
TaskManager.defineTask(BACKGROUND_TASK, async () => {
  try {
    // Cold start — the case background tasks exist for: the session store
    // boots as "loading" and only app/_layout.tsx calls bootstrap(), which
    // never mounts headless (Android WorkManager) and has not resolved by
    // the time iOS fires the task. Prove the session here or the drain
    // refuses (no bearer, no tenant fence) and the task is inert. A
    // signedOut store with tokens still in the keychain is the
    // offline-at-launch case, which is equally worth one more /me.
    const session = useSession.getState();
    if (session.status === "loading" || (session.status === "signedOut" && (await api.currentTokens()))) {
      await session.bootstrap();
    }
    const r = await drainNow("background");
    // Nothing ran (signed out, offline, paused): report it, so the OS backs
    // off honestly instead of waking us every 15 min for nothing.
    if (!r.ran) return BackgroundTask.BackgroundTaskResult.Failed;
    return r.failed > 0 && r.sent === 0
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

let backgroundRegistered = false;

async function registerBackgroundTask() {
  if (backgroundRegistered) return;
  backgroundRegistered = true;
  const set = useOffline.getState().set;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
      set({ backgroundTask: "restricted" });
      return;
    }
    const already = await TaskManager.isTaskRegisteredAsync(BACKGROUND_TASK);
    if (!already) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_TASK, { minimumInterval: 15 });
    }
    set({ backgroundTask: "registered" });
  } catch (e) {
    // Simulator, Expo Go, or an iOS build without the fetch background mode:
    // record it for the diagnostics card and carry on. Never throw here.
    const msg = e instanceof Error ? e.message : String(e);
    set({ backgroundTask: /simulator|not available|unsupported|not supported/i.test(msg) ? "unsupported" : "error" });
  }
}

export function OfflineDrainer() {
  const status = useSession((s) => s.status);
  const queued = useOffline((s) => s.queued);
  const online = useOffline((s) => s.online);
  const prevStatus = useRef(status);
  const prevOnline = useRef<boolean | null>(null);

  // Connectivity → store, and a drain on every offline→online edge.
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const isOnline = Boolean(state.isConnected) && state.isInternetReachable !== false;
      const set = useOffline.getState().set;
      if (useOffline.getState().online !== isOnline) set({ online: isOnline });
      const wasOnline = prevOnline.current;
      prevOnline.current = isOnline;
      if (isOnline && wasOnline === false) void drainNow("reconnect");
    });
    return unsub;
  }, []);

  // Launch + session flips. A signedIn edge also lifts an auth-wait pause.
  useEffect(() => {
    if (status === "signedIn") {
      const reason = prevStatus.current === "signedIn" ? "launch" : "session";
      void drainNow(reason);
      void registerBackgroundTask();
    }
    prevStatus.current = status;
  }, [status]);

  // Foreground.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void drainNow("foreground");
    });
    return () => sub.remove();
  }, []);

  // 20s tick while there is something to send and we are online + signed in.
  useEffect(() => {
    if (status !== "signedIn" || !online || queued === 0) return;
    const id = setInterval(() => {
      if (AppState.currentState === "active") void drainNow("interval");
    }, FOREGROUND_INTERVAL_MS);
    return () => clearInterval(id);
  }, [status, online, queued]);

  // Android WorkManager honours the 15-min task; iOS may never fire it. Both
  // are registered — the status lands in the store for the diagnostics card.
  useEffect(() => {
    if (Platform.OS === "web") useOffline.getState().set({ backgroundTask: "unsupported" });
  }, []);

  return null;
}
