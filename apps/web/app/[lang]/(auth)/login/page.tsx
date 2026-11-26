"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { safeNext } from "@/lib/url-safe";
import { Store } from "@/lib/icons";
import { AuthSuspenseCard } from "../SuspenseCard";

function cleanIdentifier(v: string): string {
  return v
    .normalize("NFKC")
    .replace(/[​-‏‪-‮﻿]/g, "")
    .trim()
    .toLowerCase();
}

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthSuspenseCard />}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const { auth } = useDictionary();
  const locale = useLocale();
  const t = auth.login;
  const search = useSearchParams();
  // safeNext keeps an attacker from turning ?next=https://evil.com into an
  // open redirect after sign-in. Only same-origin relative paths survive.
  const next = safeNext(search.get("next"));
  // Set by /api/demo/exit: the visitor just left the trial store. Lead with
  // the conversion card instead of a bare login form (HANDOFF §8 item 12).
  const fromDemo = search.get("from") === "demo";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // H03 — 2FA step is shown after a first-pass submit returns TotpRequired.
  // `totp` is supplied on the second submit; the email/password fields are
  // preserved (controlled values) so the user doesn't retype.
  const [needsTotp, setNeedsTotp] = useState(false);
  const [emailValue, setEmailValue] = useState("");
  const [passwordValue, setPasswordValue] = useState("");
  const [totp, setTotp] = useState("");

  // Read the form values straight from the DOM at submit time. This is the
  // bulletproof path: browser password managers / autofill can populate
  // <input> values without firing React's onChange, which would leave any
  // controlled state stuck at "" and silently send empty credentials to
  // the server. FormData reads what's actually in the field RIGHT NOW.
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const formData = new FormData(e.currentTarget);
    const emailFromForm = cleanIdentifier(String(formData.get("email") ?? ""));
    const passwordFromForm = String(formData.get("password") ?? "");
    const email = needsTotp ? emailValue : emailFromForm;
    const password = needsTotp ? passwordValue : passwordFromForm;

    if (!email || !password) {
      setError(t.errors.missing);
      setBusy(false);
      return;
    }

    try {
      if (!needsTotp) {
        const needed = await fetch("/api/auth/2fa-needed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        })
          .then((r) => r.json() as Promise<{ needsTotp: boolean }>)
          .catch(() => ({ needsTotp: false as boolean }));
        if (needed.needsTotp) {
          setEmailValue(email);
          setPasswordValue(password);
          setNeedsTotp(true);
          setBusy(false);
          return;
        }
      }

      const csrfRes = await fetch("/api/auth/csrf");
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

      const params: Record<string, string> = {
        csrfToken,
        email,
        password,
        callbackUrl: next,
        json: "true",
      };
      if (needsTotp && totp) params.totp = totp;
      const body = new URLSearchParams(params).toString();

      await fetch("/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const sessionRes = await fetch("/api/auth/session", { cache: "no-store" });
      const session = (await sessionRes.json()) as { user?: { id?: string } };

      if (!session?.user?.id) {
        setError(needsTotp ? t.errors.badCredsOrTotp : t.errors.badCreds);
        return;
      }

      // Success — full navigation so the router cache doesn't serve pre-auth HTML.
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.18)]">
      {fromDemo && (
        <section
          data-testid="demo-exit-cta"
          className="mb-6 rounded-xl border border-accent/30 bg-accent/5 p-4 text-center space-y-3"
        >
          <div className="mx-auto w-10 h-10 rounded-full bg-accent text-white flex items-center justify-center">
            <Store className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-bold text-text-primary">{auth.demo.exitCta.title}</h2>
          <p className="text-sm text-text-secondary">{auth.demo.exitCta.body}</p>
          <Link href={`/${locale}/signup`} className="block">
            <Button type="button" className="w-full">
              {auth.demo.exitCta.button}
            </Button>
          </Link>
          <p className="text-xs text-text-secondary">{auth.demo.exitCta.haveAccount}</p>
        </section>
      )}

      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">{t.title}</h1>
        <p className="text-sm text-text-secondary mt-1">{t.subhead}</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        {!needsTotp && (
          <>
            <Input
              name="email"
              type="text"
              label={t.identifierLabel}
              required
              autoComplete="username"
              dir="ltr"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={t.identifierPlaceholder}
            />
            <PasswordInput
              name="password"
              label={t.passwordLabel}
              required
              autoComplete="current-password"
              spellCheck={false}
              autoCapitalize="off"
            />
          </>
        )}

        {needsTotp && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">{t.totpPrompt}</p>
            <Input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder={t.totpPlaceholder}
              dir="ltr"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" className="w-full" loading={busy}>
          {needsTotp ? t.confirmCode : t.submit}
        </Button>

        {needsTotp && (
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => {
              setNeedsTotp(false);
              setTotp("");
              setError(null);
              // Drop the cached values so the next submit re-reads the form.
              // Otherwise if the user edited the email/password inputs before
              // re-submitting, those edits would be ignored.
              setEmailValue("");
              setPasswordValue("");
            }}
          >
            {t.back}
          </Button>
        )}

        <div className="text-center">
          <Link
            href={`/${locale}/forgot-password`}
            className="text-xs text-text-secondary hover:text-accent"
          >
            {t.forgot}
          </Link>
        </div>
      </form>

      <div className="mt-6 pt-6 border-t border-border space-y-2">
        <p className="text-center text-sm text-text-secondary">{t.noAccount}</p>
        <Link href={`/${locale}/signup`} className="block">
          <Button variant="secondary" className="w-full" type="button">
            {t.createAccount}
          </Button>
        </Link>
      </div>
    </div>
  );
}
