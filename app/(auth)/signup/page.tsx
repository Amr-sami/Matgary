"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { signupAction } from "../actions";

export default function SignupPage() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);

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
      router.push("/onboarding");
      router.refresh();
    });
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border p-8">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">إنشاء حساب جديد</h1>
        <p className="text-sm text-text-secondary mt-1">
          أنشئ متجرك خلال أقل من دقيقة
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Input
          name="storeName"
          label="اسم المتجر"
          placeholder="متجر السعادة"
          required
          autoComplete="organization"
          error={errorField === "storeName" ? error ?? undefined : undefined}
        />
        <Input
          name="email"
          type="email"
          label="البريد الإلكتروني"
          placeholder="you@example.com"
          required
          autoComplete="email"
          dir="ltr"
          error={errorField === "email" ? error ?? undefined : undefined}
        />
        <Input
          name="password"
          type="password"
          label="كلمة المرور"
          placeholder="8 أحرف على الأقل"
          required
          autoComplete="new-password"
          dir="ltr"
          error={errorField === "password" ? error ?? undefined : undefined}
        />

        {error && !errorField && (
          <p className="text-sm text-danger">{error}</p>
        )}

        <Button type="submit" className="w-full" loading={isPending}>
          إنشاء الحساب
        </Button>
      </form>

      <p className="text-center text-sm text-text-secondary mt-6">
        لديك حساب بالفعل؟{" "}
        <Link href="/login" className="text-accent hover:underline">
          تسجيل الدخول
        </Link>
      </p>
    </div>
  );
}
