"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="bg-white p-4 lg:p-8 text-center text-text-secondary lg:rounded-2xl lg:shadow-sm lg:border lg:border-border">
          …
        </div>
      }
    >
      <ResetInner />
    </Suspense>
  );
}

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
      // Auto-bounce to login after a short success state.
      setTimeout(() => router.push(`/${locale}/login`), 2000);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
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
        <div className="text-center space-y-3">
          <p className="text-success font-medium">{t.successMsg}</p>
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
