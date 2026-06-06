"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2, X } from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { signupAction, type SignupErrorCode, type SignupField } from "../actions";

// Suggest a store handle from the email's local part.
function suggestHandle(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
  return cleaned.length >= 2 ? cleaned : "";
}

export default function SignupPage() {
  const { auth } = useDictionary();
  const locale = useLocale();
  const t = auth.signup;
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  // Surfaced when signupAction succeeds at DB level but auto-signIn fails.
  // The tenant + user exist; the user just needs to sign in manually.
  const [accountReady, setAccountReady] = useState(false);

  // Codes come back from the server action; map them to localized strings
  // here. Single source of truth for "what does this code mean to the user".
  function messageFor(code: SignupErrorCode): string {
    switch (code) {
      case "BAD_EMAIL_FORMAT":
        return t.errors.badEmail;
      case "WEAK_PASSWORD":
        return t.errors.shortPassword;
      case "STORE_NAME_REQUIRED":
        return t.errors.storeNameRequired;
      case "HANDLE_INVALID":
        return t.errors.handleInvalid;
      case "EMAIL_TAKEN":
        return t.emailTaken;
      case "HANDLE_TAKEN":
        return t.handleTaken;
      case "RATE_LIMITED":
        return t.errors.rateLimited;
      case "AUTO_LOGIN_FAILED":
        return t.errors.autoLoginFailed;
      case "INTERNAL":
      default:
        return t.errors.internal;
    }
  }

  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [storeHandle, setStoreHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [handleStatus, setHandleStatus] = useState<
    "idle" | "checking" | "available" | "taken" | "invalid"
  >("idle");
  // Live email availability: same shape as handleStatus. Without this, users
  // only found out a duplicate email at step-2 submit, after filling in store
  // name + handle.
  const [emailStatus, setEmailStatus] = useState<
    "idle" | "checking" | "available" | "taken" | "invalid"
  >("idle");

  const goToStep2 = () => {
    setError(null);
    setErrorField(null);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(t.errors.badEmail);
      setErrorField("email");
      return;
    }
    if (emailStatus === "taken") {
      setError(t.emailTaken);
      setErrorField("email");
      return;
    }
    if (!password || password.length < 8) {
      setError(t.errors.shortPassword);
      setErrorField("password");
      return;
    }
    setStep(2);
  };

  useEffect(() => {
    if (!handleEdited) {
      setStoreHandle(suggestHandle(email));
    }
  }, [email, handleEdited]);

  useEffect(() => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setEmailStatus("idle");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailStatus("invalid");
      return;
    }
    setEmailStatus("checking");
    const ctrl = new AbortController();
    const tm = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/account/email/check?email=${encodeURIComponent(trimmed)}`,
          { signal: ctrl.signal },
        );
        const json = await res.json();
        if (json.reason === "invalid") setEmailStatus("invalid");
        else setEmailStatus(json.available ? "available" : "taken");
      } catch {
        // ignore — likely the next keystroke aborted us
      }
    }, 350);
    return () => {
      clearTimeout(tm);
      ctrl.abort();
    };
  }, [email]);

  useEffect(() => {
    if (!storeHandle || storeHandle.length < 2) {
      setHandleStatus("idle");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(storeHandle)) {
      setHandleStatus("invalid");
      return;
    }
    setHandleStatus("checking");
    const ctrl = new AbortController();
    const tm = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/account/store-handle/check?handle=${encodeURIComponent(storeHandle)}`,
          { signal: ctrl.signal },
        );
        const json = await res.json();
        if (json.reason === "invalid") setHandleStatus("invalid");
        else setHandleStatus(json.available ? "available" : "taken");
      } catch {
        // ignore — likely the next keystroke aborted us
      }
    }, 350);
    return () => {
      clearTimeout(tm);
      ctrl.abort();
    };
  }, [storeHandle]);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setErrorField(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await signupAction(formData);
      if (!res.ok) {
        // AUTO_LOGIN_FAILED is a "soft" failure — the tenant + user exist,
        // we just need the user to sign in manually. Render a dedicated
        // panel instead of a generic field error.
        if (res.code === "AUTO_LOGIN_FAILED") {
          setAccountReady(true);
          return;
        }
        setError(messageFor(res.code));
        setErrorField((res.field as SignupField | undefined) ?? null);
        return;
      }
      // Full reload defeats Next's router cache, which can otherwise show
      // stale HTML for /onboarding (or worse, redirect back to /login) on
      // the very first navigation after signup.
      window.location.href = `/${locale}/onboarding`;
    });
  };

  // "Account ready, please sign in" state — shown when signup succeeded at
  // DB level but auto-signIn failed (rare, transient).
  if (accountReady) {
    return (
      <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.18)] text-center space-y-4">
        <h1 className="text-2xl font-bold text-text-primary">
          {t.accountReadyTitle}
        </h1>
        <p className="text-sm text-text-secondary leading-relaxed">
          {t.accountReadyBody}
        </p>
        <Link href={`/${locale}/login`} className="block">
          <Button className="w-full">{t.goToLogin}</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.18)]">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">{t.title}</h1>
        <p className="text-sm text-text-secondary mt-1">
          {step === 1 ? t.step1Sub : t.step2Sub}
        </p>
        <div className="flex items-center justify-center gap-2 mt-3">
          <span
            className={`h-1.5 w-8 rounded-full ${step === 1 ? "bg-accent" : "bg-accent/30"}`}
          />
          <span
            className={`h-1.5 w-8 rounded-full ${step === 2 ? "bg-accent" : "bg-accent/30"}`}
          />
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className={step === 1 ? "space-y-4" : "hidden"}>
          <div>
            <Input
              name="email"
              type="email"
              label={t.emailLabel}
              placeholder={t.emailPlaceholder}
              required
              autoComplete="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={errorField === "email" ? error ?? undefined : undefined}
            />
            {emailStatus === "available" && (
              <p className="mt-1 text-xs text-success">{t.emailAvailable}</p>
            )}
            {emailStatus === "taken" && (
              <p className="mt-1 text-xs text-danger">{t.emailTaken}</p>
            )}
          </div>
          <PasswordInput
            name="password"
            label={t.passwordLabel}
            placeholder={t.passwordPlaceholder}
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errorField === "password" ? error ?? undefined : undefined}
          />

          {error && !errorField && (
            <p className="text-sm text-danger">{error}</p>
          )}

          <Button
            type="button"
            className="w-full"
            onClick={goToStep2}
            disabled={
              emailStatus === "checking" ||
              emailStatus === "taken" ||
              emailStatus === "invalid"
            }
          >
            {t.next}
          </Button>
        </div>

        <div className={step === 2 ? "space-y-4" : "hidden"}>
          <Input
            name="storeName"
            label={t.storeNameLabel}
            placeholder={t.storeNamePlaceholder}
            required={step === 2}
            autoComplete="organization"
            error={errorField === "storeName" ? error ?? undefined : undefined}
          />

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              {t.handleLabel}
            </label>
            <div className="flex items-center gap-1 bg-white border border-border rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-accent">
              <span dir="ltr" className="px-3 py-2.5 text-text-secondary bg-bg-main text-sm">
                @
              </span>
              <input
                name="storeHandle"
                type="text"
                dir="ltr"
                required={step === 2}
                minLength={2}
                maxLength={40}
                placeholder={t.handlePlaceholder}
                value={storeHandle}
                onChange={(e) => {
                  setStoreHandle(
                    e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                  );
                  setHandleEdited(true);
                }}
                className="flex-1 px-3 py-2.5 bg-transparent focus:outline-none text-text-primary"
              />
              <div className="px-3 py-2.5">
                {handleStatus === "checking" && (
                  <Loader2 className="w-4 h-4 text-text-secondary animate-spin" />
                )}
                {handleStatus === "available" && <Check className="w-4 h-4 text-success" />}
                {(handleStatus === "taken" || handleStatus === "invalid") && (
                  <X className="w-4 h-4 text-danger" />
                )}
              </div>
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              {t.handleHint}{" "}
              <span dir="ltr" className="font-mono text-text-primary">
                ahmed@{handleStatus === "invalid" || !storeHandle
                  ? "yourstore"
                  : storeHandle}
              </span>
            </p>
            {handleStatus === "available" && (
              <p className="mt-1 text-xs text-success">{t.handleAvailable}</p>
            )}
            {handleStatus === "taken" && (
              <p className="mt-1 text-xs text-danger">{t.handleTaken}</p>
            )}
            {handleStatus === "invalid" && storeHandle.length >= 2 && (
              <p className="mt-1 text-xs text-danger">{t.handleInvalid}</p>
            )}
            {errorField === "storeHandle" && error && (
              <p className="mt-1 text-sm text-danger">{error}</p>
            )}
          </div>

          {error && !errorField && (
            <p className="text-sm text-danger">{error}</p>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={() => {
                setError(null);
                setErrorField(null);
                setStep(1);
              }}
            >
              {t.previous}
            </Button>
            <Button
              type="submit"
              className="flex-1"
              loading={isPending}
              disabled={handleStatus === "taken" || handleStatus === "invalid" || handleStatus === "checking"}
            >
              {t.submit}
            </Button>
          </div>
        </div>
      </form>

      <div className="mt-6 pt-6 border-t border-border space-y-2">
        <p className="text-center text-sm text-text-secondary">{t.haveAccountQ}</p>
        <Link href={`/${locale}/login`} className="block">
          <Button variant="secondary" className="w-full" type="button">
            {t.signIn}
          </Button>
        </Link>
      </div>
    </div>
  );
}
