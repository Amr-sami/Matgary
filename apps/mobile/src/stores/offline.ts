import { create } from "zustand";

/**
 * What the UI knows about the offline engine — written ONLY by
 * src/offline/outbox.ts and <OfflineDrainer/>, read by <OfflineChip/>, the
 * /sync screen and the POS receipt state. Persisted state lives in SQLite;
 * this store is a derived, in-memory mirror that is rebuilt on launch.
 */
export interface OfflineState {
  /** NetInfo's last word: connected and the internet not known to be unreachable. */
  online: boolean;
  /** A drain pass is in flight. */
  draining: boolean;
  /** Rows waiting to be sent (status queued|sending). */
  queued: number;
  /** Rows a human must look at (status failed). */
  failed: number;
  /** Epoch ms of the last successful send, or last empty drain. Null until then. */
  lastSyncedAt: number | null;
  /** The most recent send error's message, for the chip tooltip / sync screen. */
  lastError: string | null;
  /**
   * Why the drainer is refusing to run. `auth` — a row hit a session or
   * billing wall. Lifted by a session flip, a /me that no longer states a
   * wall, a manual sync / retry, or by itself after 5 minutes. Null = free.
   */
  paused: "auth" | null;
  /** Epoch ms the pause began — the engine expires it from here. */
  pausedAt: number | null;
  /** The wall's machine code ("TENANT_SUSPENDED", "session", …) for the chip / sync screen. */
  pausedCode: string | null;
  /** expo-background-task registration outcome, for /settings/about-style diagnostics. */
  backgroundTask: "unknown" | "registered" | "restricted" | "unsupported" | "error";
  /** Bumped on every outbox row change; `useOutbox()` re-reads the list on it. */
  revision: number;
  set: (patch: Partial<Omit<OfflineState, "set">>) => void;
}

export const useOffline = create<OfflineState>((set) => ({
  online: true,
  draining: false,
  queued: 0,
  failed: 0,
  lastSyncedAt: null,
  lastError: null,
  paused: null,
  pausedAt: null,
  pausedCode: null,
  backgroundTask: "unknown",
  revision: 0,
  set: (patch) => set(patch),
}));
