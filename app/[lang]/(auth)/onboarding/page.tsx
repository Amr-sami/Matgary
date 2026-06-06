"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { completeOnboardingAction } from "../actions";

type Preset = "cornerstore" | "blank";

export default function OnboardingPage() {
  const { auth } = useDictionary();
  const locale = useLocale();
  const t = auth.onboarding;
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
      // Full reload — the router cache otherwise lingers on this very page
      // and the user sees onboarding again until they manually refresh.
      // After onboarding the user is logged-in → app root (unprefixed) is fine.
      window.location.href = "/";
    });
  };

  // Locale on the onboarding step actions is kept off the dependency since the
  // success path always lands the user inside the logged-in app at "/".
  void locale;

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
              {t.step1.title}
            </h1>
            <p className="text-sm text-text-secondary mt-1">
              {t.step1.subhead}
            </p>
          </div>
          <Input
            label={t.step1.shopNameLabel}
            placeholder={t.step1.shopNamePlaceholder}
            value={shopName}
            onChange={(e) => setShopName(e.target.value)}
            required
          />
          <Input
            label={t.step1.shopPhoneLabel}
            placeholder={t.step1.shopPhonePlaceholder}
            value={shopPhone}
            onChange={(e) => setShopPhone(e.target.value)}
            dir="ltr"
          />
          <Button
            className="w-full"
            disabled={!shopName.trim()}
            onClick={() => setStep(2)}
          >
            {t.step1.next}
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-text-primary">
              {t.step2.title}
            </h1>
            <p className="text-sm text-text-secondary mt-1">
              {t.step2.subhead}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setPreset("cornerstore")}
            className={`w-full text-start p-4 rounded-xl border-2 transition-colors ${
              preset === "cornerstore"
                ? "border-accent bg-accent-light"
                : "border-border bg-white hover:border-accent"
            }`}
          >
            <div className="font-bold text-text-primary mb-1">
              {t.step2.cornerstoreTitle}
            </div>
            <div className="text-sm text-text-secondary">
              {t.step2.cornerstoreBody}
            </div>
          </button>

          <button
            type="button"
            onClick={() => setPreset("blank")}
            className={`w-full text-start p-4 rounded-xl border-2 transition-colors ${
              preset === "blank"
                ? "border-accent bg-accent-light"
                : "border-border bg-white hover:border-accent"
            }`}
          >
            <div className="font-bold text-text-primary mb-1">
              {t.step2.blankTitle}
            </div>
            <div className="text-sm text-text-secondary">
              {t.step2.blankBody}
            </div>
          </button>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep(1)} className="flex-1">
              {t.step2.back}
            </Button>
            <Button onClick={() => setStep(3)} className="flex-1">
              {t.step2.next}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-text-primary">{t.step3.title}</h1>
            <p className="text-sm text-text-secondary mt-1">
              {preset === "cornerstore"
                ? t.step3.subheadCornerstore
                : t.step3.subheadBlank}
            </p>
          </div>

          <ul className="text-sm text-text-secondary space-y-2 bg-bg-main rounded-lg p-4">
            {t.step3.tips.map((tip, i) => (
              <li key={i}>
                {tip.before}
                {tip.link && <span className="text-accent">{tip.link}</span>}
                {tip.after}
              </li>
            ))}
          </ul>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setStep(2)}
              className="flex-1"
              disabled={isPending}
            >
              {t.step3.back}
            </Button>
            <Button onClick={submit} className="flex-1" loading={isPending}>
              {t.step3.start}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
