import type { ReactNode } from "react";

interface SkeletonShellProps {
  children: ReactNode;
}

/**
 * Static visual replica of `AppShell` — used by `loading.tsx` fallbacks so
 * the streaming skeleton sits inside the same sidebar + header + mobile-
 * bottom-nav frame the real page renders. No providers, no client state,
 * no data fetching: just empty boxes the right shape and color, so the
 * loading state on mobile looks like the app instead of a bare grey
 * rectangle sitting in the viewport.
 *
 * Outer container mirrors `components/layout/AppShell.tsx` 1:1 — same
 * sidebar width (52 on lg), same `ms-52` offset, same `p-4 md:p-6` main
 * padding, same `pb-[calc(5rem+env(safe-area-inset-bottom))]` so the
 * skeleton's last row doesn't get buried under the mobile bottom nav.
 */
export function SkeletonShell({ children }: SkeletonShellProps) {
  return (
    <div className="min-h-screen bg-bg-main overflow-x-hidden pt-[env(safe-area-inset-top)]">
      {/* Desktop sidebar placeholder — same dimensions as AppShell's */}
      <div
        aria-hidden
        className="hidden lg:block fixed start-0 top-0 h-screen w-52 pt-[env(safe-area-inset-top)] bg-bg-card border-e border-border z-40"
      />

      {/* Main content area with the desktop sidebar offset baked in */}
      <div className="min-h-[calc(100vh-env(safe-area-inset-top))] flex flex-col lg:ms-52">
        <main className="flex-1 p-4 md:p-6 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-6">
          {children}
        </main>
      </div>

      {/* Mobile bottom-nav placeholder bar. Height has to GROW by the bottom
          inset: `h-16` + `padding-bottom` is a border-box, so once the inset
          resolves to a real value the padding would eat the bar's 4rem of
          visible height instead of extending it, and the placeholder would end
          up shorter than the real nav it stands in for. */}
      <div
        aria-hidden
        className="lg:hidden fixed bottom-0 inset-x-0 z-50 h-[calc(4rem+env(safe-area-inset-bottom))] bg-bg-card border-t border-border pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      />
    </div>
  );
}
