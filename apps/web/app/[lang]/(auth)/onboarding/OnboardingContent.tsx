"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/Button";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import {
  BarChart3,
  History,
  ListChecks,
  Package,
  PlusCircle,
  Receipt,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingCart,
  Store,
  Truck,
  Users,
  Wallet,
} from "@/lib/icons";
import {
  completeOnboardingAction,
  type OnboardingErrorCode,
} from "../actions";

type Preset = "cornerstore" | "blank";
type Step = 1 | 2;

// Where each step-2 (review) tip's `link` token actually lands the user.
// Logged-in app routes are unprefixed.
const TIP_HREFS = ["/inventory/new", "/sales", "/settings"] as const;

// Visual config for the tour slides. Pairs each slide (by index, same order
// as `t.tour.slides[]`) with the icon + accent + screenshot to render.
// Drop a real PNG at /public/onboarding-tour/{locale}/{slug}.png and it
// replaces the mock illustration automatically.
const TOUR_SLIDES = [
  { Icon: Store,        slug: "dashboard",   accent: "from-violet-100 to-violet-50",  ring: "bg-violet-500",  text: "text-violet-600" },
  { Icon: Package,      slug: "inventory",   accent: "from-indigo-100 to-indigo-50",  ring: "bg-indigo-500",  text: "text-indigo-600" },
  { Icon: PlusCircle,   slug: "add-product", accent: "from-sky-100 to-sky-50",        ring: "bg-sky-500",     text: "text-sky-600" },
  { Icon: ShoppingCart, slug: "sales",       accent: "from-emerald-100 to-emerald-50", ring: "bg-emerald-500", text: "text-emerald-600" },
  { Icon: Users,        slug: "customers",   accent: "from-rose-100 to-rose-50",      ring: "bg-rose-500",    text: "text-rose-600" },
  { Icon: BarChart3,    slug: "reports",     accent: "from-amber-100 to-amber-50",    ring: "bg-amber-500",   text: "text-amber-600" },
  { Icon: Receipt,      slug: "purchases",   accent: "from-cyan-100 to-cyan-50",      ring: "bg-cyan-600",    text: "text-cyan-700" },
  { Icon: Truck,        slug: "suppliers",   accent: "from-teal-100 to-teal-50",      ring: "bg-teal-600",    text: "text-teal-700" },
  { Icon: ListChecks,   slug: "tasks",       accent: "from-fuchsia-100 to-fuchsia-50", ring: "bg-fuchsia-500", text: "text-fuchsia-600" },
  { Icon: Wallet,       slug: "expenses",    accent: "from-orange-100 to-orange-50",  ring: "bg-orange-500",  text: "text-orange-600" },
  { Icon: ShieldCheck,  slug: "team",        accent: "from-blue-100 to-blue-50",      ring: "bg-blue-500",    text: "text-blue-600" },
  { Icon: History,      slug: "activity",    accent: "from-purple-100 to-purple-50",  ring: "bg-purple-500",  text: "text-purple-600" },
  { Icon: SettingsIcon, slug: "settings",    accent: "from-slate-100 to-slate-50",    ring: "bg-slate-500",   text: "text-slate-600" },
] as const;

interface Props {
  /** Pre-filled from `tenants.name` so step 1 doesn't re-ask. */
  initialShopName: string;
}

export function OnboardingContent({ initialShopName }: Props) {
  const { auth } = useDictionary();
  const locale = useLocale();
  const t = auth.onboarding;
  const { update: refreshSession } = useSession();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState<Step>(1);
  const [preset, setPreset] = useState<Preset>("cornerstore");
  const [error, setError] = useState<string | null>(null);
  // Tour takes over the FULL viewport (fixed inset-0) when active, hiding
  // the auth showcase panel + onboarding card behind it. Triggered from
  // step 2's primary CTA; either Skip or Finish on the last slide submits.
  const [tourActive, setTourActive] = useState(false);
  const [tourSlide, setTourSlide] = useState(0);
  // Shop name + phone used to be collected on a dedicated step 1; that
  // step was removed because the name is already set at signup and the
  // phone is optional (editable later in Settings). The submit action
  // still requires shopName, so we forward whatever the tenant row had.
  const shopName = initialShopName;
  // Track which slides failed to load a real screenshot so we render the
  // mock illustration instead. Persists across slide swaps within one
  // mount — we only retry on a fresh page load.
  const [missingShots, setMissingShots] = useState<Set<number>>(new Set());

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
    // Phone left empty intentionally — the dedicated shop-info step was
    // removed; users set the phone later in Settings → Shop.
    fd.append("shopPhone", "");
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

  const tips = t.step2.tips[preset];

  return (
    <>
    <div className="bg-white rounded-2xl shadow-sm border border-border p-8 w-full">
      <div className="flex flex-col items-center gap-2 mb-6">
        <div className="flex items-center justify-center gap-2">
          {[1, 2].map((n) => (
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
              {t.step1.cornerstoreTitle}
            </div>
            <div className="text-sm text-text-secondary">
              {t.step1.cornerstoreBody}
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
              {t.step1.blankTitle}
            </div>
            <div className="text-sm text-text-secondary">
              {t.step1.blankBody}
            </div>
          </button>

          <Button onClick={() => setStep(2)} className="w-full">
            {t.step1.next}
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-text-primary">{t.step2.title}</h1>
            <p className="text-sm text-text-secondary mt-1">
              {preset === "cornerstore"
                ? t.step2.subheadCornerstore
                : t.step2.subheadBlank}
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
              onClick={() => setStep(1)}
              className="flex-1"
            >
              {t.step2.back}
            </Button>
            <Button
              onClick={() => {
                setTourSlide(0);
                setTourActive(true);
              }}
              className="flex-1"
            >
              {t.step2.next}
            </Button>
          </div>
        </div>
      )}
    </div>
    {tourActive && (() => {
      const slidesCount = t.tour.slides.length;
      const slide = t.tour.slides[tourSlide];
      const vis = TOUR_SLIDES[tourSlide];
      const isLast = tourSlide === slidesCount - 1;
      const isFirst = tourSlide === 0;
      const showMock = missingShots.has(tourSlide);
      const Icon = vis.Icon;

      return (
        // Fullscreen overlay — covers the auth layout's form column AND
        // the AuthShowcase panel behind it (z-50 beats the layout's
        // z-20 locale switcher too).
        <div className="fixed inset-0 z-50 bg-white overflow-y-auto">
          <div className="min-h-full flex items-center justify-center p-4 sm:p-8">
            <div className="w-full max-w-2xl space-y-5">
              <div className="text-center">
                <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">
                  {t.tour.title}
                </h1>
                <p className="text-sm text-text-secondary mt-1">
                  {t.tour.subhead}
                </p>
              </div>

              {/* Slide stage — `key` forces a remount on change so the
                  CSS entrance animations replay. */}
              <div key={tourSlide} className="space-y-4">
                <div
                  className={`tour-slide__visual relative aspect-[16/10] w-full overflow-hidden rounded-2xl bg-gradient-to-br ${vis.accent} flex items-center justify-center`}
                >
                  {showMock ? (
                    <div className="tour-slide__visual-inner flex flex-col items-center gap-3 px-6 text-center">
                      <div
                        className={`flex h-20 w-20 items-center justify-center rounded-2xl ${vis.ring} text-white shadow-lg shadow-black/10`}
                      >
                        <Icon className="h-10 w-10" weight="duotone" />
                      </div>
                      <div
                        className={`text-xs font-bold uppercase tracking-wide ${vis.text}`}
                      >
                        {slide.tag}
                      </div>
                    </div>
                  ) : (
                    <Image
                      src={`/onboarding-tour/${locale}/${vis.slug}.png`}
                      alt={slide.title}
                      fill
                      sizes="(max-width: 640px) 100vw, 720px"
                      className="object-cover"
                      onError={() =>
                        setMissingShots((prev) => new Set(prev).add(tourSlide))
                      }
                      priority={isFirst}
                    />
                  )}
                </div>

                <div className="text-center space-y-2">
                  <div
                    className={`tour-slide__title text-xs font-bold uppercase tracking-wide ${vis.text}`}
                  >
                    {slide.tag}
                  </div>
                  <h2 className="tour-slide__title text-xl sm:text-2xl font-bold text-text-primary">
                    {slide.title}
                  </h2>
                  <p className="tour-slide__body text-sm sm:text-base text-text-secondary leading-relaxed max-w-xl mx-auto">
                    {slide.body}
                  </p>
                </div>
              </div>

              {/* Dots: clickable to jump between slides. */}
              <div
                className="flex items-center justify-center gap-2"
                role="tablist"
              >
                {t.tour.slides.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    role="tab"
                    aria-selected={i === tourSlide}
                    aria-label={`${i + 1} / ${slidesCount}`}
                    onClick={() => setTourSlide(i)}
                    className={`h-2 rounded-full transition-all ${
                      i === tourSlide
                        ? "w-8 bg-accent"
                        : "w-2 bg-border hover:bg-text-secondary/40"
                    }`}
                  />
                ))}
              </div>

              {error && <p className="text-sm text-danger text-center">{error}</p>}

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={submit}
                  disabled={isPending}
                  className="flex-shrink-0"
                >
                  {t.tour.skip}
                </Button>
                <div className="flex-1" />
                {!isFirst && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setTourSlide((i) => Math.max(0, i - 1))}
                    disabled={isPending}
                  >
                    {t.tour.prev}
                  </Button>
                )}
                {isLast ? (
                  <Button onClick={submit} loading={isPending}>
                    {t.tour.finish}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => setTourSlide((i) => i + 1)}
                    disabled={isPending}
                  >
                    {t.tour.next}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    })()}
    </>
  );
}
