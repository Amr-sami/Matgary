"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Sets `shown=true` the first time the ref enters the viewport.
 * Disconnects after firing so it never reverses on scroll-up.
 * Falls back to `shown=true` immediately when IntersectionObserver
 * is unavailable (older browsers, SSR-only env).
 */
export function useScrollReveal<T extends HTMLElement = HTMLDivElement>(
  rootMargin = "-50px 0px",
) {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          obs.disconnect();
        }
      },
      { rootMargin },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [rootMargin]);

  return { ref, shown };
}
