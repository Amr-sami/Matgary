"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./NotificationBell";

const LG = "(min-width: 1024px)";

/**
 * Where the app shell shows the notification bell (doc 15 spec 12 §4.9).
 * `components/layout/Header.tsx` is not rendered by AppShell, so the bell
 * lives in the desktop Sidebar's brand row and in the phone "More" sheet.
 * Both navs are always mounted (CSS hides one), and every bell opens its own
 * SSE stream (hooks/useNotifications.ts) — so this renders the bell only in
 * the nav that matches the viewport: one stream per tab (12 R4).
 */
export function ShellNotificationBell({ place, className }: { place: "sidebar" | "mobile"; className?: string }) {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(LG);
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  if (desktop == null) return null;
  if ((place === "sidebar") !== desktop) return null;
  return (
    <div
      className={cn(
        // The dropdown opens toward the page: from the sidebar it grows into
        // the content; from the bottom sheet it opens upward.
        place === "sidebar"
          ? "[&_[role=dialog]]:end-auto [&_[role=dialog]]:start-0"
          : // 44 px tap target on phones (the compact bell is 32 px).
            "[&>div>button]:w-11 [&>div>button]:h-11 [&_[role=dialog]]:top-auto [&_[role=dialog]]:bottom-full [&_[role=dialog]]:mt-0 [&_[role=dialog]]:mb-2 [&_[role=dialog]]:w-[min(360px,calc(100vw-2rem))] [&_[role=dialog]>div:last-child]:max-h-[50vh]",
        className,
      )}
    >
      <NotificationBell variant="compact" />
    </div>
  );
}
