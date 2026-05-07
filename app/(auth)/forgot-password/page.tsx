"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export default function ForgotPasswordPage() {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
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
        setError(json.error || "تعذر إرسال الطلب");
        return;
      }
      setSubmitted(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full bg-white p-4 lg:p-8 lg:rounded-2xl lg:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.18)]">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text-primary">نسيت كلمة المرور؟</h1>
        <p className="text-sm text-text-secondary mt-1">
          أدخل بريدك الإلكتروني وسنرسل لك رابطاً لإعادة الضبط.
        </p>
      </div>

      {submitted ? (
        <div className="space-y-4 text-center">
          <p className="text-sm text-text-primary">
            إذا كان البريد مسجّلاً عندنا، ستجد رسالة بها رابط إعادة الضبط في صندوقك خلال دقائق.
          </p>
          <p className="text-xs text-text-secondary">
            الرابط صالح لمدة 30 دقيقة. تذكّر مراجعة مجلد البريد المزعج.
          </p>
          <Link href="/login" className="block">
            <Button variant="secondary" className="w-full" type="button">
              العودة لتسجيل الدخول
            </Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Input
            name="email"
            type="email"
            label="البريد الإلكتروني"
            required
            autoComplete="email"
            dir="ltr"
            placeholder="you@example.com"
          />

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="submit" className="w-full" loading={busy}>
            إرسال رابط إعادة الضبط
          </Button>

          <Link href="/login" className="block text-center text-sm text-text-secondary hover:text-accent">
            العودة لتسجيل الدخول
          </Link>
        </form>
      )}
    </div>
  );
}
