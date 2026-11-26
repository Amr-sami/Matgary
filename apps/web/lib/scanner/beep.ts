// Shared scanner-beep player. We can't rely on the decoder library's own
// sound prop because it plays the audio AFTER the user-gesture window
// has closed on iOS Safari — every play() call past the first one is
// silently denied.
//
// The trick: every Scan button calls `primeBeep()` *inside* its onClick
// handler. That runs synchronously inside the iOS gesture window and
// performs a silent muted play() → pause(). iOS marks the element as
// "user-unlocked" for the rest of the session. Subsequent
// `playBeep()` calls (fired from detection callbacks, well outside the
// gesture window) then succeed.
//
// We keep a single module-level Audio element so the unlock survives
// across modal opens — re-creating it would lose the unlock state on
// some iOS versions.

let sharedAudio: HTMLAudioElement | null = null;

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  if (!sharedAudio) {
    sharedAudio = new Audio("/sounds/scanner-beep.wav");
    sharedAudio.preload = "auto";
  }
  return sharedAudio;
}

/**
 * Call from a Scan button's onClick (or any user-gesture handler) BEFORE
 * navigating into async work. Performs a silent unlock-play so the
 * subsequent playBeep() — fired async from detection — is allowed by
 * iOS Safari's autoplay policy.
 */
export function primeBeep(): void {
  const a = ensureAudio();
  if (!a) return;
  try {
    a.muted = true;
    const p = a.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      }).catch(() => {
        // Permission denied — sound will be silent until next gesture.
        a.muted = false;
      });
    }
  } catch {
    // Older browsers may throw synchronously; harmless.
  }
}

/** Fire the beep. No-op if priming hasn't happened in this session. */
export function playBeep(): void {
  const a = sharedAudio;
  if (!a) return;
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {});
    }
  } catch {
    // Element detached or context closed — silent fallback.
  }
}
