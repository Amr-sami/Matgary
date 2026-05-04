"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2, X } from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { signupAction } from "../actions";

// Suggest a store handle from the email's local part. Strips anything that
// isn't a-z0-9-, lowercases, and ensures it's at least 2 chars.
function suggestHandle(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
  return cleaned.length >= 2 ? cleaned : "";
}

export default function SignupPage() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);

  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [storeHandle, setStoreHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [handleStatus, setHandleStatus] = useState<
    "idle" | "checking" | "available" | "taken" | "invalid"
  >("idle");

  const goToStep2 = () => {
    setError(null);
    setErrorField(null);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("أدخل بريداً إلكترونياً صحيحاً");
      setErrorField("email");
      return;
    }
    if (!password || password.length < 8) {
      setError("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
      setErrorField("password");
      return;
    }
    setStep(2);
  };

  // Auto-suggest handle from email until the user types something themselves.
  useEffect(() => {
    if (!handleEdited) {
      setStoreHandle(suggestHandle(email));
    }
  }, [email, handleEdited]);

  // Live availability lookup, debounced. Tells the user before submit whether
  // the handle they want is free.
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
    const t = setTimeout(async () => {
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
      clearTimeout(t);
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
        setError(res.error);
        setErrorField(res.field ?? null);
        return;
      }
      // Full reload defeats Next's router cache, which can otherwise show
      // stale HTML for /onboarding (or worse, redirect back to /login) on
      // the very first navigation after signup.
      window.location.href = "/onboarding";
    });
  };

  return (
    <div className="w-full bg-white rounded-2xl shadow-[0_20px_50px_-12px_rgba(0,0,0,0.18)] p-8">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">إنشاء حساب جديد</h1>
        <p className="text-sm text-text-secondary mt-1">
          {step === 1 ? "ابدأ بإنشاء حسابك" : "أخبرنا عن متجرك"}
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
          <Input
            name="email"
            type="email"
            label="بريدك الإلكتروني"
            placeholder="you@example.com"
            required
            autoComplete="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errorField === "email" ? error ?? undefined : undefined}
          />
          <PasswordInput
            name="password"
            label="كلمة المرور"
            placeholder="8 أحرف على الأقل"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errorField === "password" ? error ?? undefined : undefined}
          />

          {error && !errorField && (
            <p className="text-sm text-danger">{error}</p>
          )}

          <Button type="button" className="w-full" onClick={goToStep2}>
            التالي
          </Button>
        </div>

        <div className={step === 2 ? "space-y-4" : "hidden"}>
          <Input
            name="storeName"
            label="اسم المتجر (يظهر للعملاء)"
            placeholder="متجر السعادة"
            required={step === 2}
            autoComplete="organization"
            error={errorField === "storeName" ? error ?? undefined : undefined}
          />

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              اسم تسجيل الدخول للمتجر
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
                placeholder="elhenawystore"
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
              يستخدمه موظفوك لتسجيل الدخول، مثل{" "}
              <span dir="ltr" className="font-mono text-text-primary">
                ahmed@{storeHandle || "yourstore"}
              </span>
            </p>
            {handleStatus === "available" && (
              <p className="mt-1 text-xs text-success">متاح ✓</p>
            )}
            {handleStatus === "taken" && (
              <p className="mt-1 text-xs text-danger">
                هذا الاسم مستخدم بالفعل في متجر آخر — اختر اسماً مختلفاً
              </p>
            )}
            {handleStatus === "invalid" && storeHandle.length >= 2 && (
              <p className="mt-1 text-xs text-danger">
                حروف إنجليزية صغيرة وأرقام و - فقط، يبدأ وينتهي بحرف أو رقم
              </p>
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
              السابق
            </Button>
            <Button
              type="submit"
              className="flex-1"
              loading={isPending}
              disabled={handleStatus === "taken" || handleStatus === "invalid" || handleStatus === "checking"}
            >
              إنشاء الحساب
            </Button>
          </div>
        </div>
      </form>

      <div className="mt-6 pt-6 border-t border-border space-y-2">
        <p className="text-center text-sm text-text-secondary">لديك حساب بالفعل؟</p>
        <Link href="/login" className="block">
          <Button variant="secondary" className="w-full" type="button">
            تسجيل الدخول
          </Button>
        </Link>
      </div>
    </div>
  );
}
