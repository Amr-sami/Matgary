"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";

function cleanIdentifier(v: string): string {
  return v
    .normalize("NFKC")
    .replace(/[​-‏‪-‮﻿]/g, "")
    .trim()
    .toLowerCase();
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="bg-white p-4 lg:p-8 text-center text-text-secondary lg:rounded-2xl lg:shadow-sm lg:border lg:border-border">
          …
        </div>
      }
    >
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const search = useSearchParams();
  const next = search.get("next") || "/";
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
      setError("أدخل البريد وكلمة المرور");
      setBusy(false);
      return;
    }

    try {
      // Step 1 (only on the first submit) — ask the server whether this
      // email has 2FA enabled. Avoids Auth.js v5's flaky custom-error-code
      // propagation by detecting the need for TOTP BEFORE submitting the
      // password.
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
        // Could be wrong password OR (when needsTotp) wrong/expired TOTP
        // code. We can't distinguish the two from the session probe alone;
        // the message stays generic to avoid leaking which one failed.
        setError(
          needsTotp
            ? "كلمة المرور أو الرمز غير صحيحة"
            : "البريد أو كلمة المرور غير صحيحة",
        );
        return;
      }

      // Success — full navigation so the router cache doesn't serve pre-auth HTML.
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تسجيل الدخول");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.18)]">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">تسجيل الدخول</h1>
        <p className="text-sm text-text-secondary mt-1">أهلاً بعودتك</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        {!needsTotp && (
          <>
            <Input
              name="email"
              type="text"
              label="البريد أو اسم المستخدم"
              required
              autoComplete="username"
              dir="ltr"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="you@example.com  •  username@yourstore"
            />
            <PasswordInput
              name="password"
              label="كلمة المرور"
              required
              autoComplete="current-password"
              spellCheck={false}
              autoCapitalize="off"
            />
          </>
        )}

        {needsTotp && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة، أو رمزاً احتياطياً (xxxxx-xxxxx).
            </p>
            <Input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="123456"
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
          {needsTotp ? "تأكيد الرمز" : "تسجيل الدخول"}
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
            }}
          >
            رجوع
          </Button>
        )}

        <div className="text-center">
          <Link
            href="/forgot-password"
            className="text-xs text-text-secondary hover:text-accent"
          >
            نسيت كلمة المرور؟
          </Link>
        </div>
      </form>

      <div className="mt-6 pt-6 border-t border-border space-y-2">
        <p className="text-center text-sm text-text-secondary">ليس لديك حساب؟</p>
        <Link href="/signup" className="block">
          <Button variant="secondary" className="w-full" type="button">
            إنشاء حساب جديد
          </Button>
        </Link>
      </div>
    </div>
  );
}
