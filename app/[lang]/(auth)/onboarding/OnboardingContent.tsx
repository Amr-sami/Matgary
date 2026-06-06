"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { isValidEgyptPhoneAny } from "@/lib/validators/egypt";
import {
  completeOnboardingAction,
  type OnboardingErrorCode,
} from "../actions";

type Preset = "cornerstore" | "blank";

// Where each step-3 tip's `link` token actually lands the user. The logged-in
// app is Arabic-only in Phase 1, so these routes are unprefixed. When the
// logged-in app gets localized, prefix with locale here.
const TIP_HREFS = ["/inventory/new", "/sales", "/settings"] as const;

interface Props {
  /** Pre-filled from `tenants.name` so step 1 doesn't re-ask. */
  initialShopName: string;
}

export function OnboardingContent({ initialShopName }: Props) {
  const { auth } = useDictionary();
  const t = auth.onboarding;
  const { update: refreshSession } = useSession();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [shopName, setShopName] = useState(initialShopName);
  const [shopPhone, setShopPhone] = useState("");
  const [preset, setPreset] = useState<Preset>("cornerstore");
  const [error, setError] = useState<string | null>(null);

  function messageFor(code: OnboardingErrorCode): string {
    switch (code) {
      case "UNAUTHORIZED":
        return t.errors.unauthorized;
      case "SHOP_NAME_REQUIRED":
        return t.errors.shopNameRequired;
      case "INVALID_PHONE":
        return t.errors.invalidPhone;
      case "INVALID_INPUT":
        return t.errors.invalidInput;
      case "PRIMARY_BRANCH_MISSING":
        return t.errors.primaryBranchMissing;
      case "INTERNAL":
      default:
        return t.errors.internal;
    }
  }

  // Empty phone is allowed (optional field); a typed-but-invalid one blocks
  // step 1 so users don't carry a bad number all the way to the server.
  const phoneValid =
    shopPhone.trim().length === 0 || isValidEgyptPhoneAny(shopPhone);

  // "Step N of total · Label" — combines two dictionary strings into one
  // readable header. `stepCounter` uses {n} / {total} placeholders.
  const stepHeader = (() => {
    const counter = t.stepCounter
      .replace("{n}", String(step))
      .replace("{total}", String(t.stepLabels.length));
    return `${counter} · ${t.stepLabels[step - 1] ?? ""}`;
  })();

  const submit = () => {
    setError(null);
    const fd = new FormData();
    fd.append("shopName", shopName);
    fd.append("shopPhone", shopPhone);
    fd.append("preset", preset);
    startTransition(async () => {
      const res = await completeOnboardingAction(fd);
      if (!res.ok) {
        setError(messageFor(res.code));
        return;
      }
      // Best-effort JWT refresh: writes a fresh cookie with
      // onboardingComplete=true so the middleware gate doesn't bounce the
      // user back on the next navigation. If the call throws (network blip,
      // session route hiccup), fall through to the hard nav anyway — the
      // middleware will still pick up the new claim on its own page render.
      try {
        await refreshSession();
      } catch {
        // ignored on purpose
      }
      // After onboarding the user is logged-in → app root (unprefixed)
      // is fine because the logged-in app is Arabic-only in Phase 1.
      window.location.href = "/";
    });
  };

  const tips = t.step3.tips[preset];

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-border p-8">
      <div className="flex flex-col items-center gap-2 mb-6">
        <div className="flex items-center justify-center gap-2">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className={`h-2 w-8 rounded-full transition-colors ${
                step >= n ? "bg-accent" : "bg-border"
              }`}
            />
          ))}
        </div>
        <p className="text-xs text-text-secondary">{stepHeader}</p>
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
          <div>
            <Input
              label={t.step1.shopPhoneLabel}
              placeholder={t.step1.shopPhonePlaceholder}
              value={shopPhone}
              onChange={(e) => setShopPhone(e.target.value)}
              dir="ltr"
              error={!phoneValid ? t.errors.invalidPhone : undefined}
            />
          </div>
          <Button
            className="w-full"
            disabled={!shopName.trim() || !phoneValid}
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
            {tips.map((tip, i) => (
              <li key={i}>
                {tip.before}
                {tip.link && (
                  <Link
                    href={TIP_HREFS[i] ?? "/"}
                    className="text-accent hover:underline underline-offset-4"
                  >
                    {tip.link}
                  </Link>
                )}
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
