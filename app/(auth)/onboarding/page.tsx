"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { completeOnboardingAction } from "../actions";

type Preset = "cornerstore" | "blank";

export default function OnboardingPage() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [shopName, setShopName] = useState("");
  const [shopPhone, setShopPhone] = useState("");
  const [preset, setPreset] = useState<Preset>("cornerstore");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const fd = new FormData();
    fd.append("shopName", shopName);
    fd.append("shopPhone", shopPhone);
    fd.append("preset", preset);
    startTransition(async () => {
      const res = await completeOnboardingAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Middleware no longer checks onboardingComplete (JWT can be stale at the
      // edge), so a plain push lands us on the dashboard. The DB-backed truth
      // is whatever shop_settings.shop_name now is.
      router.replace("/");
      router.refresh();
    });
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border p-8">
      <div className="flex items-center justify-center gap-2 mb-6">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className={`h-2 w-8 rounded-full transition-colors ${
              step >= n ? "bg-accent" : "bg-border"
            }`}
          />
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-text-primary">
              أخبرنا عن متجرك
            </h1>
            <p className="text-sm text-text-secondary mt-1">
              معلومات سريعة لنبدأ
            </p>
          </div>
          <Input
            label="اسم المتجر"
            placeholder="متجر السعادة"
            value={shopName}
            onChange={(e) => setShopName(e.target.value)}
            required
          />
          <Input
            label="رقم الهاتف (اختياري)"
            placeholder="01xxxxxxxxx"
            value={shopPhone}
            onChange={(e) => setShopPhone(e.target.value)}
            dir="ltr"
          />
          <Button
            className="w-full"
            disabled={!shopName.trim()}
            onClick={() => setStep(2)}
          >
            التالي
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-text-primary">
              اختر نقطة البداية
            </h1>
            <p className="text-sm text-text-secondary mt-1">
              يمكنك تغيير كل شيء لاحقاً من الإعدادات
            </p>
          </div>

          <button
            type="button"
            onClick={() => setPreset("cornerstore")}
            className={`w-full text-right p-4 rounded-xl border-2 transition-colors ${
              preset === "cornerstore"
                ? "border-accent bg-accent-light"
                : "border-border bg-white hover:border-accent"
            }`}
          >
            <div className="font-bold text-text-primary mb-1">
              تجربة Corner Store الكاملة
            </div>
            <div className="text-sm text-text-secondary">
              تبدأ بأقسام جاهزة: ساعات، برفانات، نظارات — مع الأنواع والماركات.
            </div>
          </button>

          <button
            type="button"
            onClick={() => setPreset("blank")}
            className={`w-full text-right p-4 rounded-xl border-2 transition-colors ${
              preset === "blank"
                ? "border-accent bg-accent-light"
                : "border-border bg-white hover:border-accent"
            }`}
          >
            <div className="font-bold text-text-primary mb-1">ابدأ من الصفر</div>
            <div className="text-sm text-text-secondary">
              عرّف الأقسام والخصائص بنفسك من الإعدادات.
            </div>
          </button>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep(1)} className="flex-1">
              رجوع
            </Button>
            <Button onClick={() => setStep(3)} className="flex-1">
              التالي
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-text-primary">جاهز للانطلاق</h1>
            <p className="text-sm text-text-secondary mt-1">
              {preset === "cornerstore"
                ? "ستجد الأقسام جاهزة في لوحة التحكم."
                : "ابدأ بإضافة أول قسم من الإعدادات."}
            </p>
          </div>

          <ul className="text-sm text-text-secondary space-y-2 bg-bg-main rounded-lg p-4">
            <li>✓ أضف منتجاتك من <span className="text-accent">إضافة منتج</span></li>
            <li>✓ سجّل أول عملية بيع من <span className="text-accent">المبيعات</span></li>
            <li>✓ خصّص الإعدادات والـ WhatsApp لاحقاً</li>
          </ul>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setStep(2)}
              className="flex-1"
              disabled={isPending}
            >
              رجوع
            </Button>
            <Button onClick={submit} className="flex-1" loading={isPending}>
              ابدأ
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
