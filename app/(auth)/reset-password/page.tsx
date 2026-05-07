"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { PasswordInput } from "@/components/ui/PasswordInput";

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
      setError("كلمة المرور لازم تكون 8 أحرف على الأقل");
      setBusy(false);
      return;
    }
    if (newPassword !== confirm) {
      setError("كلمتا المرور غير متطابقتين");
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
        setError(json.error || "تعذر إعادة الضبط");
        return;
      }
      setDone(true);
      // Auto-bounce to login after a short success state.
      setTimeout(() => router.push("/login"), 2000);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-sm">
        <p className="text-sm text-danger text-center">
          رابط غير صالح. اطلب رابطاً جديداً من{" "}
          <Link href="/forgot-password" className="text-accent">
            نسيت كلمة المرور
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.18)]">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">كلمة مرور جديدة</h1>
        <p className="text-sm text-text-secondary mt-1">
          اختر كلمة مرور جديدة لحسابك.
        </p>
      </div>

      {done ? (
        <div className="text-center space-y-3">
          <p className="text-success font-medium">تم تغيير كلمة المرور بنجاح ✓</p>
          <p className="text-xs text-text-secondary">جاري تحويلك لصفحة الدخول…</p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <PasswordInput
            name="newPassword"
            label="كلمة المرور الجديدة"
            required
            autoComplete="new-password"
            spellCheck={false}
          />
          <PasswordInput
            name="confirm"
            label="تأكيد كلمة المرور"
            required
            autoComplete="new-password"
            spellCheck={false}
          />

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="submit" className="w-full" loading={busy}>
            تغيير كلمة المرور
          </Button>
        </form>
      )}
    </div>
  );
}
