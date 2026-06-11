"use client";

import { useTransition } from "react";
import { useSession, signOut } from "next-auth/react";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

/** Persistent red banner at the very top of every authed page whenever the
 *  current tenant session was minted via the impersonation flow. NOT
 *  dismissible — Spec 07 §2.4 / §7.2. */
export function ImpersonationBanner() {
  const { data: session } = useSession();
  const dict = useDictionary();
  const t = dict.app.impersonationBanner;
  const [busy, startTransition] = useTransition();

  if (!session?.impersonation) return null;
  const { adminEmail, expiresAt } = session.impersonation;
  const minutesLeft = Math.max(
    0,
    Math.floor((expiresAt - Date.now()) / 60_000),
  );

  const exit = () =>
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/impersonation/exit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const json = (await res.json().catch(() => ({}))) as {
          redirectTo?: string;
        };
        // After the impersonation cookie is dropped, force a full sign-out
        // and a hard navigation so the admin lands at the tenant detail
        // page with a clean slate (no stale session.user data lingering on
        // the page).
        await signOut({ redirect: false });
        window.location.assign(json.redirectTo ?? "/");
      } catch {
        window.location.assign("/");
      }
    });

  const ownerLabel = session.user?.name ?? session.user?.email ?? "—";
  const msg = t.message
    .replace("{owner}", ownerLabel)
    .replace("{admin}", adminEmail);

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 bg-danger text-white border-b border-danger/30 shadow"
    >
      <div className="max-w-7xl mx-auto px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium leading-snug" dir="auto">
          <span aria-hidden className="me-1">⚠</span>
          {msg}
          <span className="text-xs opacity-80 ms-2" dir="ltr">
            ({t.minutesLeft.replace("{n}", String(minutesLeft))})
          </span>
        </p>
        <button
          type="button"
          onClick={exit}
          disabled={busy}
          className="text-xs font-semibold bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 disabled:opacity-50"
        >
          {busy ? "…" : t.exitCta}
        </button>
      </div>
    </div>
  );
}
