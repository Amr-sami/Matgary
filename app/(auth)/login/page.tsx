"use client";

import { Suspense, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { loginAction } from "../actions";

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="bg-white rounded-2xl shadow-sm border border-border p-8 text-center text-text-secondary">…</div>}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") || "/";
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await loginAction(formData);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(next);
      router.refresh();
    });
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border p-8">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">تسجيل الدخول</h1>
        <p className="text-sm text-text-secondary mt-1">أهلاً بعودتك</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Input
          name="email"
          type="email"
          label="البريد الإلكتروني"
          required
          autoComplete="email"
          dir="ltr"
        />
        <Input
          name="password"
          type="password"
          label="كلمة المرور"
          required
          autoComplete="current-password"
          dir="ltr"
        />

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" className="w-full" loading={isPending}>
          تسجيل الدخول
        </Button>
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
