"use client";

import { useEffect, useRef, useState } from "react";

// SSR renders shown=true so the page is visible without JS. On mount, below-fold
// elements snap to hidden (off-screen, so the user can't see the flash) then
// animate in as they scroll into view.
export function useScrollReveal<T extends HTMLElement = HTMLDivElement>(
  rootMargin = "-50px 0px",
) {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") return;
    const rect = node.getBoundingClientRect();
    const inView = rect.top < window.innerHeight && rect.bottom > 0;
    if (inView) return;
    setShown(false);
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
