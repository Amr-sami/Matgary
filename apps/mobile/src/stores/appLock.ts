import { create } from "zustand";
import { createMMKV } from "react-native-mmkv";

/**
 * App lock (doc 06 §7.4). A screen-level gate, not an auth factor: the
 * session, the cart and the outbox all survive it, and a failed unlock never
 * wipes anything.
 *
 * Two of the four fields persist. `enabled` and `requireAfterSeconds` are the
 * user's choice and outlive the process; `locked` and `lastUnlockedAt` are
 * process state — a cold start is locked by definition, so persisting
 * `locked` would only ever re-derive `enabled`.
 *
 * MMKV rather than SecureStore: nothing here is a secret (whether the lock is
 * on is visible on the lock screen itself), and the read has to be
 * synchronous so the very first render already knows whether to cover the
 * app — an async hydrate would flash the shop for a frame.
 */

/** 0 = every time the app leaves the foreground. */
export type RequireAfterSeconds = 0 | 60 | 300;

export const REQUIRE_AFTER_OPTIONS: readonly RequireAfterSeconds[] = [0, 60, 300];

const UNLOCK_GRACE_MS = 2000;

const KEY_ENABLED = "enabled";
const KEY_REQUIRE_AFTER = "requireAfterSeconds";

const storage = createMMKV({ id: "app-lock" });

function readEnabled(): boolean {
  try {
    return storage.getBoolean(KEY_ENABLED) ?? false;
  } catch {
    return false;
  }
}

/** Doc 06 §7.4: the lock asks again after more than 5 minutes away by default. */
const DEFAULT_REQUIRE_AFTER: RequireAfterSeconds = 300;

function readRequireAfter(): RequireAfterSeconds {
  try {
    const raw = storage.getNumber(KEY_REQUIRE_AFTER);
    return REQUIRE_AFTER_OPTIONS.includes(raw as RequireAfterSeconds)
      ? (raw as RequireAfterSeconds)
      : DEFAULT_REQUIRE_AFTER;
  } catch {
    return DEFAULT_REQUIRE_AFTER;
  }
}

interface AppLockState {
  /** Persisted. Off by default. */
  enabled: boolean;
  /** Persisted. Background time before the next foreground asks again. */
  requireAfterSeconds: RequireAfterSeconds;
  /** In-memory. Epoch ms of the last successful unlock (or enable). */
  lastUnlockedAt: number | null;
  /** In-memory. True from cold start when enabled; the gate renders on it. */
  locked: boolean;

  /**
   * Turn the lock on or off. Callers turning it ON must have passed one
   * `authenticateAsync` first (the settings screen does); enabling counts as
   * an unlock so the user is not immediately asked a second time.
   */
  setEnabled: (enabled: boolean) => void;
  setRequireAfterSeconds: (seconds: RequireAfterSeconds) => void;
  /** Cover the app. No-op while disabled — there is nothing to unlock with. */
  lock: () => void;
  /** Biometrics / passcode passed, or a fresh sign-in proved the user. */
  unlock: () => void;
  /**
   * The app spent `hiddenForMs` in the background and is back. Locks when
   * that exceeds the configured threshold.
   */
  onForeground: (hiddenForMs: number) => void;
}

export const useAppLock = create<AppLockState>((set, get) => {
  const enabled = readEnabled();
  return {
    enabled,
    requireAfterSeconds: readRequireAfter(),
    lastUnlockedAt: null,
    // Cold start: if the lock is on, the app opens covered.
    locked: enabled,

    setEnabled: (next) => {
      try {
        storage.set(KEY_ENABLED, next);
      } catch {
        // Persistence failing must not strand the user in a lock they cannot
        // configure; the in-memory state still wins for this process.
      }
      set(
        next
          ? { enabled: true, locked: false, lastUnlockedAt: Date.now() }
          : { enabled: false, locked: false },
      );
    },

    setRequireAfterSeconds: (seconds) => {
      try {
        storage.set(KEY_REQUIRE_AFTER, seconds);
      } catch {
        // See setEnabled.
      }
      set({ requireAfterSeconds: seconds });
    },

    lock: () => {
      if (!get().enabled) return;
      set({ locked: true });
    },

    unlock: () => set({ locked: false, lastUnlockedAt: Date.now() }),

    onForeground: (hiddenForMs) => {
      const { enabled, requireAfterSeconds, locked, lastUnlockedAt } = get();
      if (!enabled || locked) return;
      // Android's device-credential fallback is its own activity: the app
      // goes to the background while the user types their PIN and comes back
      // the instant they succeed. That success IS the unlock — do not ask
      // again because of the round trip it took.
      if (lastUnlockedAt != null && Date.now() - lastUnlockedAt < UNLOCK_GRACE_MS) return;
      if (hiddenForMs >= requireAfterSeconds * 1000) set({ locked: true });
    },
  };
});
