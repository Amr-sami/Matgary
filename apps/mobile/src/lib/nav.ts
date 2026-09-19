import { useCallback } from "react";
import { type Href, router, usePathname } from "expo-router";

/**
 * Back navigation that always lands somewhere.
 *
 * `router.back()` on its own is a no-op when there is nothing to pop, and the
 * app reaches that state more often than a web stack does: a cold-start deep
 * link or push-notification tap lands directly on a sub-screen; the root Stack
 * is re-keyed on the locale (app/_layout.tsx), so a live language switch
 * remounts the navigator with an empty history; a protected group swap
 * (sign-in / sign-out) drops the other group's stack. In every one of those the
 * user taps "‹ Settings" and nothing happens — the 2026-09-18 English-simulator
 * Terms report.
 *
 * So: pop when we can, otherwise REPLACE the current screen with its parent.
 * Replace, not push/navigate — the screen the user is leaving had nothing
 * behind it, so leaving it must not stack the parent on top of it (a later
 * swipe-back would otherwise return to the orphan).
 */

/**
 * The parent of a pathname: everything up to the last segment.
 * "/settings/receipt" → "/settings"; "/inventory" → "/"; "/" → "/".
 * `usePathname()` strips route groups, so this is the URL the user sees.
 */
export function parentOf(pathname: string): Href {
  const trimmed = pathname.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return (cut <= 0 ? "/" : trimmed.slice(0, cut)) as Href;
}

/**
 * Where /legal/[doc]'s back link lands with no history. `from` is the
 * `?from=` route key the pusher set (about | signup). Without one, the only
 * screens that link to the documents are About (signed in) and the public
 * auth screens (signed out).
 */
export function legalParent(from: string | undefined, signedIn: boolean): Href {
  if (from === "about") return "/settings/about";
  if (from === "signup") return "/signup";
  return signedIn ? "/settings/about" : "/login";
}

/**
 * Imperative form, for callbacks that cannot call hooks (a mutation's
 * onSuccess, a timer). Prefer `useGoBack` in components: it derives the
 * parent from the live pathname when no fallback is given.
 */
export function goBack(fallback: Href = "/"): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

/**
 * A stable back handler: pops if there is history, otherwise replaces the
 * current screen with `fallback` (default: the pathname's parent).
 *
 * Pass an explicit parent whenever the URL hierarchy and the UI hierarchy
 * differ — `/sales/[id]` is reached from `/sales/history`, `/notifications`
 * is a hidden tab whose way out is home — so the fallback matches the label
 * on the link ("‹ Sales history" really goes to sales history).
 */
export function useGoBack(fallback?: Href): () => void {
  const pathname = usePathname();
  const target = fallback ?? parentOf(pathname);
  return useCallback(() => goBack(target), [target]);
}
