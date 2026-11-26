/**
 * A one-shot notice handed from the account form to the hub (doc 15 spec 09
 * §4.4 "On success: … show a notice, and goBack"): the form pops itself, so
 * the sentence is shown by the screen the user lands on. Taken once.
 */
import { create } from "zustand";

export type SetupNotice = { tone: "ok" | "err"; text: string };

interface NoticeState {
  pending: SetupNotice | null;
  put: (n: SetupNotice) => void;
  take: () => SetupNotice | null;
}

export const useSetupNotice = create<NoticeState>((set, get) => ({
  pending: null,
  put: (n) => set({ pending: n }),
  take: () => {
    const n = get().pending;
    if (n) set({ pending: null });
    return n;
  },
}));
