"use client";

import { useTransition } from "react";
import { signOut } from "next-auth/react";

interface Props {
  title: string;
  message: string;
  reasonLabel: string;
  reason: string | null;
  contactHint: string;
  signOutLabel: string;
}

export function ServicePausedClient({
  title,
  message,
  reasonLabel,
  reason,
  contactHint,
  signOutLabel,
}: Props) {
  const [signingOut, startSignOut] = useTransition();

  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-border rounded-2xl p-6 shadow-sm text-center space-y-4">
        <div className="w-12 h-12 mx-auto rounded-full bg-danger-light text-danger flex items-center justify-center text-2xl">
          ⛔
        </div>
        <h1 className="text-xl font-bold text-text-primary">{title}</h1>
        <p className="text-sm text-text-secondary" dir="auto">
          {message}
        </p>
        {reason && (
          <div className="text-start bg-bg-main/50 rounded-lg p-3">
            <p className="text-[11px] text-text-secondary uppercase tracking-wider">
              {reasonLabel}
            </p>
            <p className="text-sm text-text-primary mt-1" dir="auto">
              {reason}
            </p>
          </div>
        )}
        <p className="text-xs text-text-secondary">{contactHint}</p>
        <div className="pt-2 border-t border-border">
          <button
            type="button"
            disabled={signingOut}
            onClick={() =>
              startSignOut(async () => {
                try {
                  window.localStorage.removeItem("shop:settings:v1");
                } catch {}
                await signOut({ callbackUrl: "/" });
              })
            }
            className="text-sm text-text-secondary hover:text-accent disabled:opacity-50"
          >
            {signingOut ? "…" : signOutLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
