"use client";

import { useEffect, useState } from "react";

// Defers expensive side-effects (network polls, SSE handshakes, etc.)
// out of the critical first-paint window. Returns `true` only after
// the page has had a chance to settle, the user has interacted, or a
// fixed timeout has elapsed — whichever happens first.
//
// Use it like a feature flag in a hook:
//
//   const armed = useDeferred();
//   useEffect(() => {
//     if (!armed) return;
//     // ... open EventSource / start polling / fetch background data
//   }, [armed, ...]);
//
// Wakeup sources:
//   - requestIdleCallback (browser says "you're free")
//   - first pointerdown / keydown anywhere (user is present)
//   - fixed `timeoutMs` fallback (so headless / idle tabs still arm)
//
// Trade-off: a tab opened in the background and never focused will
// still arm after `timeoutMs`. Set timeoutMs based on how stale the
// downstream data may go: notifications/badges want ~2 s; less
// time-sensitive deferred work can use 5–10 s.
export function useDeferred(timeoutMs: number = 2000): boolean {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (armed) return;
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      setArmed(true);
    };

    const fallback = setTimeout(fire, timeoutMs);
    const idleId =
      typeof (window as { requestIdleCallback?: unknown }).requestIdleCallback ===
      "function"
        ? (window as unknown as {
            requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number;
          }).requestIdleCallback(fire, { timeout: timeoutMs })
        : null;
    window.addEventListener("pointerdown", fire, { once: true, passive: true });
    window.addEventListener("keydown", fire, { once: true });

    return () => {
      clearTimeout(fallback);
      if (idleId !== null) {
        const cic = (window as { cancelIdleCallback?: (id: number) => void })
          .cancelIdleCallback;
        if (typeof cic === "function") cic(idleId);
      }
      window.removeEventListener("pointerdown", fire);
      window.removeEventListener("keydown", fire);
    };
  }, [armed, timeoutMs]);

  return armed;
}
