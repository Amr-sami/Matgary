"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { AuthSuspenseCard } from "../SuspenseCard";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthSuspenseCard />}>
      <ResetInner />
    </Suspense>
  );
}

// Auto-redirect on success is a courtesy, not a primary path. Users with
// reduced-motion or slow devices need a button they can click.
const AUTO_REDIRECT_MS = 5000;

function ResetInner() {
  const { auth } = useDictionary();
  const locale = useLocale();
  const t = auth.reset;
  const search = useSearchParams();
  const router = useRouter();
  const token = search.get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Pre-validate the token on mount so a stale link surfaces immediately
  // instead of after the user has filled the form twice.
  const [tokenState, setTokenState] = useState<"checking" | "valid" | "invalid">(
    token ? "checking" : "invalid",
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const ctrl = new AbortController();
    fetch(
      `/api/account/password/reset/validate?token=${encodeURIComponent(token)}`,
      { signal: ctrl.signal },
    )
      .then((r) => r.json() as Promise<{ valid: boolean }>)
      .then((j) => {
        if (!cancelled) setTokenState(j.valid ? "valid" : "invalid");
      })
      .catch(() => {
        // Network failure → let the user try; the POST will surface the
        // real error. Better than blocking the flow on a transient blip.
        if (!cancelled) setTokenState("valid");
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [token]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const newPassword = String(fd.get("newPassword") ?? "");
    const confirm = String(fd.get("confirm") ?? "");
    if (newPassword.length < 8) {
      setError(t.errors.short);
      setBusy(false);
      return;
    }
    if (newPassword !== confirm) {
      setError(t.errors.mismatch);
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/account/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || t.errors.generic);
        return;
      }
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  // Slow auto-redirect AFTER the success card has rendered. The "Continue
  // to sign in" button is always available — this is just a safety net.
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(
      () => router.push(`/${locale}/login`),
      AUTO_REDIRECT_MS,
    );
    return () => clearTimeout(id);
  }, [done, router, locale]);

  if (tokenState === "checking") {
    return (
      <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-sm text-center text-text-secondary">
        <p>{t.checkingLink}</p>
      </div>
    );
  }

  if (tokenState === "invalid") {
    return (
      <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-sm">
        <p className="text-sm text-danger text-center">
          {t.invalidLinkPrefix}{" "}
          <Link href={`/${locale}/forgot-password`} className="text-accent">
            {t.invalidLinkAction}
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.18)]">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">{t.title}</h1>
        <p className="text-sm text-text-secondary mt-1">{t.subhead}</p>
      </div>

      {done ? (
        <div className="text-center space-y-4">
          <p className="text-success font-medium">{t.successMsg}</p>
          <p className="text-sm text-text-secondary">{t.successBody}</p>
          <Link href={`/${locale}/login`} className="block">
            <Button className="w-full" type="button">
              {t.continueToLogin}
            </Button>
          </Link>
          <p className="text-xs text-text-secondary">{t.redirecting}</p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <PasswordInput
            name="newPassword"
            label={t.newPasswordLabel}
            required
            autoComplete="new-password"
            spellCheck={false}
          />
          <PasswordInput
            name="confirm"
            label={t.confirmLabel}
            required
            autoComplete="new-password"
            spellCheck={false}
          />

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="submit" className="w-full" loading={busy}>
            {t.submit}
          </Button>
        </form>
      )}
    </div>
  );
}
