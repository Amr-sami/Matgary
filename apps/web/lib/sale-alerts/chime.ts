/**
 * Sale-alert chime for an open dashboard tab (doc 16 §6), on the same
 * autoplay-safe pattern as lib/scanner/beep.ts:
 *  - one module-level <audio> element for /sounds/cha_ching.wav (the same
 *    original synthesized file the app ships — mobile-dev-docs/_tools/
 *    make-cha-ching.py writes both);
 *  - primeChime() runs inside a user gesture (installChimePrimer() hooks the
 *    first pointerdown/keydown on the document), doing a muted play → pause
 *    so Safari/Chrome mark the element as user-activated;
 *  - playChime() resolves false when the browser still refuses
 *    (NotAllowedError), and the toast then offers "Turn on sound", whose
 *    click primes and plays inside that gesture.
 *
 * CSP `default-src 'self'` already covers /sounds/* (lib/csp.ts).
 */
export const CHIME_SRC = "/sounds/cha_ching.wav";

/** The bits of HTMLAudioElement the chime touches (a fake in tests). */
export interface ChimeAudio {
  muted: boolean;
  currentTime: number;
  preload: string;
  play(): Promise<void> | void;
  pause(): void;
}

export interface Chime {
  prime(): void;
  play(): Promise<boolean>;
  /** True once a prime or play has succeeded in this page. */
  readonly unlocked: boolean;
}

export function createChime(factory: () => ChimeAudio | null): Chime {
  let audio: ChimeAudio | null = null;
  let unlocked = false;
  let priming = false;
  const ensure = () => {
    if (!audio) {
      audio = factory();
      if (audio) audio.preload = "auto";
    }
    return audio;
  };
  return {
    get unlocked() {
      return unlocked;
    },
    prime() {
      const a = ensure();
      if (!a || unlocked || priming) return;
      try {
        priming = true;
        a.muted = true;
        const p = a.play();
        const done = (ok: boolean) => {
          priming = false;
          try {
            a.pause();
            a.currentTime = 0;
          } catch {
            /* detached */
          }
          a.muted = false;
          if (ok) unlocked = true;
        };
        if (p && typeof p.then === "function") p.then(() => done(true), () => done(false));
        else done(true);
      } catch {
        priming = false;
        a.muted = false;
      }
    },
    async play() {
      const a = ensure();
      if (!a) return false;
      try {
        a.muted = false;
        a.currentTime = 0;
        await a.play();
        unlocked = true;
        return true;
      } catch (err) {
        // NotAllowedError = autoplay policy; anything else (decode error,
        // detached element) is also "no sound", and the toast says so.
        if (err && typeof err === "object" && (err as { name?: string }).name === "NotAllowedError") {
          unlocked = false;
        }
        return false;
      }
    },
  };
}

const browserChime = createChime(() =>
  typeof window === "undefined" || typeof Audio === "undefined" ? null : new Audio(CHIME_SRC),
);

export function primeChime(): void {
  browserChime.prime();
}

export function playChime(): Promise<boolean> {
  return browserChime.play();
}

let primerInstalled = false;

/**
 * Prime on pointerdown/keydown anywhere in the page — the usual cashier click
 * is enough to unlock the chime for the rest of the session. The listeners
 * stay on (prime() is a no-op once unlocked) so a gesture the browser did not
 * count as activation gets another go on the next one. Idempotent; returns a
 * remover for unmount.
 */
export function installChimePrimer(doc: Pick<Document, "addEventListener" | "removeEventListener"> | null =
  typeof document === "undefined" ? null : document): () => void {
  if (!doc || primerInstalled) return () => {};
  primerInstalled = true;
  const onGesture = () => {
    primeChime();
  };
  const remove = () => {
    doc.removeEventListener("pointerdown", onGesture, true);
    doc.removeEventListener("keydown", onGesture, true);
    primerInstalled = false;
  };
  doc.addEventListener("pointerdown", onGesture, true);
  doc.addEventListener("keydown", onGesture, true);
  return remove;
}
