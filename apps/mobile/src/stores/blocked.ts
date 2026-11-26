import { create } from "zustand";
import type { ApiClientOptions } from "@matgary/api-client";

/**
 * The last "wall" the API answered with — TENANT_SUSPENDED, SUBSCRIPTION_REQUIRED,
 * PASSWORD_CHANGE_REQUIRED or PERMISSION_DENIED (doc 02 §1.1 rows 19/25/26).
 *
 * Written by the api client's `onBlocked` hook (src/api/client.ts), read by
 * exactly one consumer: <SuspensionRouter/>, which routes and then clears it.
 * A store rather than a callback because the client is module-scoped and the
 * router is a React tree — the store is the seam between the two, and it
 * survives a wall arriving before the router has mounted.
 */
export type BlockedCode = Parameters<NonNullable<ApiClientOptions["onBlocked"]>>[0];

export interface BlockedEvent {
  code: BlockedCode;
  /** Epoch ms. Lets the router dedupe a burst of identical walls. */
  at: number;
  /** Server detail when present, else the code — display-only, may be Arabic. */
  message: string;
}

interface BlockedState {
  /** The wall awaiting routing. Null once the router has acted on it. */
  current: BlockedEvent | null;
  /**
   * The most recent wall, kept after `clear()`. The paused screen reads the
   * server's reason from here, since by the time it renders the router has
   * already consumed `current`.
   */
  last: BlockedEvent | null;
  /** Latest wins; the router only ever needs the most recent verdict. */
  raise: (code: BlockedCode, message: string) => void;
  clear: () => void;
}

export const useBlocked = create<BlockedState>((set) => ({
  current: null,
  last: null,
  raise: (code, message) => {
    const event: BlockedEvent = { code, at: Date.now(), message };
    set({ current: event, last: event });
  },
  clear: () => set({ current: null }),
}));
