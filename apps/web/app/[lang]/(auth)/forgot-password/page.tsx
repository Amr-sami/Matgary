"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

export default function ForgotPasswordPage() {
  const { auth } = useDictionary();
  const locale = useLocale();
  const t = auth.forgot;
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Echoed back into the success message so the user can tell whether they
  // typed the right address (#18). The form input is uncontrolled, so we
  // capture the submitted value separately.
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") ?? "").trim().toLowerCase();
    try {
      const res = await fetch("/api/account/password/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || t.errors.generic);
        return;
      }
      setSubmittedEmail(email);
      setSubmitted(true);
    } finally {
      setBusy(false);
    }
  };

  // Replace {email} in the localized template, but render the email as a
  // separate styled span so it stays clearly LTR even on Arabic pages.
  const successMessage = (() => {
    const tmpl = t.successTitleWithEmail || t.successTitle;
    const [before, after] = tmpl.split("{email}");
    return (
      <>
        {before}
        <span dir="ltr" className="font-medium text-text-primary">{submittedEmail}</span>
        {after ?? ""}
      </>
    );
  })();

  return (
    <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.18)]">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">{t.title}</h1>
        <p className="text-sm text-text-secondary mt-1">{t.subhead}</p>
      </div>

      {submitted ? (
        <div className="space-y-4 text-center">
          <p className="text-sm text-text-primary">{successMessage}</p>
          <p className="text-xs text-text-secondary">{t.successNote}</p>
          <Link href={`/${locale}/login`} className="block">
            <Button variant="secondary" className="w-full" type="button">
              {t.backToLogin}
            </Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Input
            name="email"
            type="email"
            label={t.emailLabel}
            required
            autoComplete="email"
            dir="ltr"
            placeholder={t.emailPlaceholder}
          />

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="submit" className="w-full" loading={busy}>
            {t.submit}
          </Button>

          <Link href={`/${locale}/login`} className="block text-center text-sm text-text-secondary hover:text-accent">
            {t.backToLogin}
          </Link>
        </form>
      )}
    </div>
  );
}
