"use client";

import { useEffect } from "react";

// Mounts once at the root of the authed app shell. Idempotent: registering
// the same worker twice is a no-op. Skipped in dev (HMR + service workers
// don't mix without a fight). The worker file lives at /public/sw.js so
// the browser can fetch it from the root scope.

export function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Only register in production builds. Dev's HMR pipeline conflicts
    // with the SW's network-first cache and shows confusing stale pages.
    if (process.env.NODE_ENV !== "production") return;

    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err) => {
          console.warn("[sw] registration failed:", err);
        });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}
