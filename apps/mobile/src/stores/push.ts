import { create } from "zustand";

/**
 * What the push layer knows about THIS device — read by the "This device"
 * card on /settings/notifications, written only by <PushRegistrar/>.
 *
 * `status` is the user-facing outcome of the last registration attempt:
 *  - idle            not attempted yet (signed out, or still bootstrapping)
 *  - unsupported     simulator / emulator — Expo cannot mint a token there
 *  - denied          OS permission refused; the fix lives in system settings
 *  - noProjectId     dev build without an EAS projectId — the token call
 *                    cannot succeed, so we say so instead of throwing
 *  - granted         permission ok and a token was minted (see `registered`)
 *  - error           anything else went wrong; `error` carries the message
 */
export type PushStatus =
  | "idle"
  | "unsupported"
  | "denied"
  | "noProjectId"
  | "granted"
  | "error";

interface PushState {
  status: PushStatus;
  /** The Expo push token for this install, once minted. */
  token: string | null;
  /** True once the server has acknowledged the current token. */
  registered: boolean;
  /** Display-only detail for `error` / `noProjectId`. */
  error: string | null;
  /** Bumped by the settings card's "retry" so the registrar re-runs. */
  attempt: number;
  set: (patch: Partial<Omit<PushState, "set" | "retry" | "reset">>) => void;
  retry: () => void;
  reset: () => void;
}

const initial = {
  status: "idle" as PushStatus,
  token: null,
  registered: false,
  error: null,
  attempt: 0,
};

export const usePush = create<PushState>((set) => ({
  ...initial,
  set: (patch) => set(patch),
  retry: () => set((s) => ({ attempt: s.attempt + 1, error: null })),
  reset: () => set({ ...initial }),
}));
