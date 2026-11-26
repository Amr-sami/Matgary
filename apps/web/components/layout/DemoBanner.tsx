"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { Zap, X } from "@/lib/icons";

// Persistent banner shown only on demo sessions. The exit button just
// hard-navigates to /api/demo/exit, which deletes the ephemeral tenant
// and 302-redirects to /login with the session cookie cleared — one
// round-trip, no CSRF dance, no client-side signOut.
export function DemoBanner() {
  const { data: session } = useSession();
  const { auth } = useDictionary();
  const t = auth.demo.banner;
  const [pending, setPending] = useState(false);

  if (!session?.user?.isDemo) return null;

  const onExit = () => {
    setPending(true);
    window.location.href = "/api/demo/exit";
  };

  return (
    <div className="bg-gradient-to-r from-violet-600 to-fuchsia-500 text-white shadow-sm">
      <div className="flex items-center gap-3 px-4 sm:px-6 py-2.5 max-w-7xl mx-auto">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15">
          <Zap className="h-4 w-4" weight="fill" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight">{t.title}</p>
          <p className="text-xs text-white/85 leading-tight hidden sm:block">
            {t.subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={onExit}
          disabled={pending}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-white text-violet-700 px-3 py-1.5 text-xs font-bold hover:bg-white/90 transition-colors disabled:opacity-60"
        >
          <X className="h-3.5 w-3.5" />
          <span>{pending ? t.exitting : t.exit}</span>
        </button>
      </div>
    </div>
  );
}
