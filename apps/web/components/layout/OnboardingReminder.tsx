"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { X, Zap } from "@/lib/icons";

const DISMISS_KEY = "onboarding-reminder-dismissed";

/**
 * Soft-gate substitute for the old middleware redirect. Renders a sticky
 * banner above the page content for any tenant whose owner hasn't
 * completed the onboarding wizard yet. Dismissible per-session (cleared
 * on tab close so the banner returns next visit); permanently disappears
 * once `onboardingComplete` flips true in the JWT.
 */
export function OnboardingReminder() {
  const { data: session } = useSession();
  const { auth } = useDictionary();
  const locale = useLocale();
  const t = auth.onboarding.reminder;

  const [hydrated, setHydrated] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Read the per-session dismiss flag once on mount. Done in an effect to
  // avoid SSR/hydration mismatch — sessionStorage doesn't exist on the
  // server.
  useEffect(() => {
    setHydrated(true);
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY) === "1") {
        setDismissed(true);
      }
    } catch {
      // ignored — private mode etc.
    }
  }, []);

  if (!hydrated) return null;
  if (!session?.user) return null;
  if (session.user.onboardingComplete) return null;
  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignored
    }
  };

  return (
    <div className="bg-gradient-to-r from-accent to-accent/85 text-white shadow-sm">
      <div className="flex items-center gap-3 px-4 sm:px-6 py-2.5 max-w-7xl mx-auto">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15">
          <Zap className="h-4 w-4" weight="fill" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight">{t.title}</p>
          <p className="text-xs text-white/80 leading-tight hidden sm:block">
            {t.subtitle}
          </p>
        </div>
        <Link
          href={`/${locale}/onboarding`}
          className="shrink-0 inline-flex items-center gap-1 rounded-md bg-white text-accent px-3 py-1.5 text-xs font-bold hover:bg-white/90 transition-colors"
        >
          {t.cta}
        </Link>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t.dismiss}
          className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-md text-white/80 hover:text-white hover:bg-white/15 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
