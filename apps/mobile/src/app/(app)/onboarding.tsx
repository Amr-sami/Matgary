import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useIsFocused } from "expo-router";
import {
  ChartBar,
  ClockCounterClockwise,
  Gear,
  ListChecks,
  Package,
  PlusCircle,
  Receipt,
  ShieldCheck,
  ShoppingCart,
  Storefront,
  Truck,
  Users,
  Wallet,
  type Icon,
} from "phosphor-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, auth } from "@matgary/api-client";
import { dictionaries } from "@matgary/i18n";

import { getLocale, t, useLocale } from "@/i18n";
import { api } from "@/api/client";
import { useSession } from "@/stores/session";
import { DottedGround } from "@/components/DottedGround";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { RTL, RTL_TEXT, directionStyle } from "@/theme/rtl";
import { colors, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";

/**
 * Native port of apps/web/app/[lang]/(auth)/onboarding/OnboardingContent.tsx.
 *
 * Step 1 picks a starting preset, step 2 reviews next steps, then a 13-slide
 * full-screen tour. Skip / Finish on the tour submits and lands on the
 * dashboard. Submit is POST /api/v1/onboarding/complete — the bearer twin of
 * the web's completeOnboardingAction, sharing lib/onboarding/complete.ts — so
 * the "cornerstore" preset seeds the starter catalog from the app exactly as
 * it does from the browser. Error codes are the action's, mapped onto
 * `auth.onboarding.errors.*`.
 *
 * The whole flow renders inside `Takeover`, a full-window Modal, so the tab
 * bar of the surrounding Tabs navigator never shows under a step flow.
 */

type Preset = "cornerstore" | "blank";
type Step = 1 | 2;

/** The auth.onboarding subtree, read at render time so the language switch applies. */
const T = () => dictionaries[getLocale()].auth.onboarding;

/** Where each step-2 tip's `link` token lands (same order as the web's TIP_HREFS). */
const TIP_ROUTES = {
  cornerstore: ["/add-product", "/sales", "/settings"],
  blank: ["/settings", "/add-product", "/sales"],
} as const;

/** One icon per tour slide, same order as `auth.onboarding.tour.slides`. */
const TOUR_ICONS: Icon[] = [
  Storefront,
  Package,
  PlusCircle,
  ShoppingCart,
  Users,
  ChartBar,
  Receipt,
  Truck,
  ListChecks,
  Wallet,
  ShieldCheck,
  ClockCounterClockwise,
  Gear,
];

export default function OnboardingScreen() {
  useLocale();
  const insets = useSafeAreaInsets();
  const me = useSession((s) => s.me);
  const refreshMe = useSession((s) => s.refreshMe);
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>(1);
  const [preset, setPreset] = useState<Preset>("cornerstore");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tourActive, setTourActive] = useState(false);
  const [tourSlide, setTourSlide] = useState(0);

  const dict = T();
  const shopName = me?.tenant.name ?? "";

  const submit = async () => {
    setError(null);
    if (!shopName.trim()) {
      setError(dict.errors.shopNameRequired);
      return;
    }
    setSubmitting(true);
    try {
      await auth.completeOnboarding(api, {
        preset,
        shopName: shopName.trim(),
        locale: getLocale(),
      });
      // The seed just wrote categories / brands / attributes / attribute
      // values and the shop name, so every tenant-scoped read the tabs made
      // before the wizard finished is stale — products, categories, brands,
      // ['attributes', categoryId], ['dashboard'] counts, shop settings, /me.
      // The whole tenant changed; invalidate everything rather than keep a
      // key list in step with each screen. The session store keeps its own
      // copy of /me, hence refreshMe as well.
      void qc.invalidateQueries();
      void refreshMe().catch(() => {});
      router.replace("/");
    } catch (e) {
      setError(errorCopy(e, dict.errors));
    } finally {
      setSubmitting(false);
    }
  };

  // Android back: one level up the wizard; on step 1 it stays put — this is
  // a gate, the same as the web's.
  const onBack = tourActive
    ? () => setTourActive(false)
    : step === 2
      ? () => setStep(1)
      : () => {};

  if (tourActive) {
    return (
      <Takeover onBack={onBack}>
        <Tour
          slide={tourSlide}
          onSlide={setTourSlide}
          onExit={() => setTourActive(false)}
          onDone={submit}
          submitting={submitting}
          error={error}
        />
      </Takeover>
    );
  }

  const stepHeader = `${t("auth.onboarding.stepCounter", {
    n: step,
    total: dict.stepLabels.length,
  })} · ${dict.stepLabels[step - 1] ?? ""}`;
  const tips = dict.step2.tips[preset];

  return (
    <Takeover onBack={onBack}>
      <View style={styles.root}>
        <DottedGround />
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xxl },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.logoRow}>
            <Logo />
          </View>

          <View style={styles.card}>
            <View style={styles.progress}>
              <View style={styles.dots}>
                {[1, 2].map((n) => (
                  <View
                    key={n}
                    style={[styles.dot, step >= n ? styles.dotOn : styles.dotOff]}
                  />
                ))}
              </View>
              <Text style={styles.stepHeader}>{stepHeader}</Text>
            </View>

            {step === 1 ? (
              <View style={styles.section}>
                <Text style={styles.title}>{dict.step1.title}</Text>
                <Text style={styles.subhead}>{dict.step1.subhead}</Text>

                <PresetOption
                  selected={preset === "cornerstore"}
                  title={dict.step1.cornerstoreTitle}
                  body={dict.step1.cornerstoreBody}
                  onPress={() => setPreset("cornerstore")}
                />
                <PresetOption
                  selected={preset === "blank"}
                  title={dict.step1.blankTitle}
                  body={dict.step1.blankBody}
                  onPress={() => setPreset("blank")}
                />

                <Button label={dict.step1.next} onPress={() => setStep(2)} />
              </View>
            ) : (
              <View style={styles.section}>
                <Text style={styles.title}>{dict.step2.title}</Text>
                <Text style={styles.subhead}>
                  {preset === "cornerstore"
                    ? dict.step2.subheadCornerstore
                    : dict.step2.subheadBlank}
                </Text>

                <View style={styles.tips}>
                  {tips.map((tip, i) => (
                    <Pressable
                      key={i}
                      style={styles.tipRow}
                      onPress={() => router.push(TIP_ROUTES[preset][i] ?? "/")}
                      accessibilityRole="link"
                      accessibilityLabel={`${tip.before}${tip.link}${tip.after}`}
                    >
                      <Text style={styles.tip}>
                        {tip.before}
                        <Text style={styles.tipLink}>{tip.link}</Text>
                        {tip.after}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {error && <Text style={styles.error}>{error}</Text>}

                <Button
                  label={dict.step2.next}
                  onPress={() => {
                    setTourSlide(0);
                    setTourActive(true);
                  }}
                />
                <Button
                  label={dict.step2.back}
                  variant="ghost"
                  onPress={() => setStep(1)}
                  disabled={submitting}
                />
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    </Takeover>
  );
}

/**
 * The route answers with the web action's codes; same copy, same table. But
 * the transport speaks first: http.ts throws `offline` / `timeout` with no
 * code at all, and 403 / 429 carry codes the table does not know, so those
 * kinds get the shared mobile.common copy (same as returns.tsx / tasks.tsx)
 * instead of collapsing to "something went wrong".
 */
function errorCopy(
  e: unknown,
  errors: ReturnType<typeof T>["errors"],
): string {
  if (!(e instanceof ApiError)) return errors.internal;
  if (e.status === 401) return errors.unauthorized;
  switch (e.kind) {
    case "offline":
      return t("mobile.common.offline");
    case "timeout":
      return t("mobile.common.timeout");
    case "forbidden":
      return t("mobile.common.forbidden");
    case "rateLimited":
      return t("mobile.common.tooManyAttempts");
    default:
      break;
  }
  switch (e.code) {
    case "SHOP_NAME_REQUIRED":
      return errors.shopNameRequired;
    case "INVALID_PHONE":
      return errors.invalidPhone;
    case "INVALID_INPUT":
      return errors.invalidInput;
    case "PRIMARY_BRANCH_MISSING":
      return errors.primaryBranchMissing;
    default:
      return errors.internal;
  }
}

/**
 * Full-window host for the wizard.
 *
 * `(app)` is a Tabs navigator whose custom BottomNav draws the same seven tabs
 * under every route — it reads no `tabBarStyle`, so `display: "none"` would
 * change nothing. Left as a plain tab scene the wizard sits above a bar with
 * nothing highlighted and one tap from abandoning setup. A full-screen Modal
 * is the screen-local way to own the window: it covers the bar, and it is
 * gated on focus so it drops the moment a step-2 tip pushes another tab (tab
 * scenes stay mounted). A Modal is its own native root, hence the nested
 * SafeAreaProvider and the explicit direction.
 */
function Takeover({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  const focused = useIsFocused();
  return (
    <>
      {/* Fills the tab scene so the frame before the Modal presents is not white. */}
      <View style={styles.root} />
      <Modal
        visible={focused}
        animationType="none"
        presentationStyle="fullScreen"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={onBack}
      >
        <SafeAreaProvider>
          <View style={[styles.flex, directionStyle(getLocale() === "ar")]}>{children}</View>
        </SafeAreaProvider>
      </Modal>
    </>
  );
}

function PresetOption({
  selected,
  title,
  body,
  onPress,
}: {
  selected: boolean;
  title: string;
  body: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionOn,
        pressed && styles.optionPressed,
      ]}
    >
      <View style={[styles.radio, selected && styles.radioOn]}>
        {selected && <View style={styles.radioDot} />}
      </View>
      <View style={styles.flex}>
        <Text style={styles.optionTitle}>{title}</Text>
        <Text style={styles.optionBody}>{body}</Text>
      </View>
    </Pressable>
  );
}

function Tour({
  slide,
  onSlide,
  onExit,
  onDone,
  submitting,
  error,
}: {
  slide: number;
  onSlide: (n: number) => void;
  onExit: () => void;
  onDone: () => void;
  submitting: boolean;
  error: string | null;
}) {
  const insets = useSafeAreaInsets();
  const tour = T().tour;
  const total = tour.slides.length;
  const current = tour.slides[slide];
  const SlideIcon = TOUR_ICONS[slide] ?? Storefront;
  const last = slide === total - 1;

  return (
    <View
      style={[
        styles.tourRoot,
        { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.lg },
      ]}
    >
      <View style={styles.tourTop}>
        <Pressable
          onPress={onExit}
          disabled={submitting}
          hitSlop={8}
          style={styles.tourTextBtn}
          accessibilityRole="button"
        >
          <Text style={styles.tourTextBtnLabel}>{tour.back}</Text>
        </Pressable>
        <Text style={styles.tourCounter}>
          {t("mobile.onboarding.slideCounter", { n: slide + 1, total })}
        </Text>
        {/* Skip submits from any slide; the Finish button's spinner only
            exists on the last one, so the request shows its progress here. */}
        <Pressable
          onPress={onDone}
          disabled={submitting}
          hitSlop={8}
          style={styles.tourTextBtn}
          accessibilityRole="button"
          accessibilityState={{ disabled: submitting, busy: submitting }}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Text style={styles.tourTextBtnLabel}>{tour.skip}</Text>
          )}
        </Pressable>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.tourBody}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.tourHeading}>{tour.title}</Text>
        <Text style={styles.tourSubhead}>{tour.subhead}</Text>

        <View style={styles.tourIllustration}>
          <View style={styles.tourIconRing}>
            <SlideIcon size={44} color={colors.card} weight="fill" />
          </View>
        </View>

        <View style={styles.tourTag}>
          <Text style={styles.tourTagText}>{current?.tag}</Text>
        </View>
        <Text style={styles.tourTitle}>{current?.title}</Text>
        <Text style={styles.tourText}>{current?.body}</Text>

        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>

      <View style={styles.tourDots}>
        {tour.slides.map((_, i) => (
          <Pressable
            key={i}
            onPress={() => onSlide(i)}
            disabled={submitting}
            accessibilityRole="tab"
            accessibilityState={{ selected: i === slide }}
            accessibilityLabel={t("mobile.onboarding.slideCounter", { n: i + 1, total })}
            hitSlop={{ top: 16, bottom: 16, left: 2, right: 2 }}
            style={styles.tourDotHit}
          >
            <View
              style={[styles.tourDot, i === slide ? styles.tourDotOn : styles.tourDotOff]}
            />
          </Pressable>
        ))}
      </View>

      <View style={styles.tourNav}>
        <View style={styles.flex}>
          <Button
            label={tour.prev}
            variant="outline"
            onPress={() => onSlide(Math.max(0, slide - 1))}
            disabled={slide === 0 || submitting}
          />
        </View>
        <View style={styles.flex}>
          <Button
            label={last ? tour.finish : tour.next}
            onPress={last ? onDone : () => onSlide(Math.min(total - 1, slide + 1))}
            loading={last && submitting}
            disabled={submitting}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  flex: { flex: 1 },
  content: { paddingHorizontal: spacing.xl, flexGrow: 1, justifyContent: "center" },
  logoRow: { alignItems: "center", marginBottom: spacing.xl },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xxl,
    gap: spacing.lg,
  },
  progress: { alignItems: "center", gap: spacing.sm },
  dots: { flexDirection: "row", gap: spacing.sm },
  dot: { height: 8, width: 32, borderRadius: radius.full },
  dotOn: { backgroundColor: colors.accent },
  dotOff: { backgroundColor: colors.border },
  stepHeader: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  section: { gap: spacing.md },
  title: {
    fontFamily: fonts.bold,
    fontSize: 22,
    color: colors.text,
    textAlign: "center",
  },
  subhead: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    minHeight: MIN_TOUCH,
    ...RTL,
  },
  optionOn: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  optionPressed: { opacity: 0.85 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  radioOn: { borderColor: colors.accent },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  optionTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    ...RTL_TEXT,
  },
  optionBody: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
    ...RTL_TEXT,
  },
  tips: {
    gap: spacing.sm,
    backgroundColor: colors.neutralTint,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  tipRow: { minHeight: MIN_TOUCH, justifyContent: "center" },
  tip: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
    ...RTL_TEXT,
  },
  tipLink: {
    fontFamily: fonts.semibold,
    color: colors.accent,
    textDecorationLine: "underline",
  },
  error: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.danger,
    backgroundColor: colors.dangerLight,
    borderRadius: radius.md,
    padding: spacing.md,
    textAlign: "center",
  },

  // ── Tour ────────────────────────────────────────────────────────────────
  tourRoot: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xl,
    ...RTL,
  },
  tourTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    ...RTL,
  },
  tourTextBtn: {
    minHeight: MIN_TOUCH,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  },
  tourTextBtnLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.accent,
  },
  tourCounter: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  tourBody: { flexGrow: 1, justifyContent: "center", gap: spacing.md, paddingVertical: spacing.lg },
  tourHeading: {
    fontFamily: fonts.bold,
    fontSize: 20,
    color: colors.text,
    textAlign: "center",
  },
  tourSubhead: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: "center",
  },
  tourIllustration: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accentLight,
    borderRadius: radius.xl,
    paddingVertical: spacing.xxl * 2,
    marginVertical: spacing.md,
  },
  tourIconRing: {
    width: 88,
    height: 88,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  tourTag: {
    alignSelf: "center",
    backgroundColor: colors.accentLight,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  tourTagText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.accent,
  },
  tourTitle: {
    fontFamily: fonts.bold,
    fontSize: 20,
    color: colors.text,
    textAlign: "center",
  },
  tourText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.textSecondary,
    lineHeight: 24,
    textAlign: "center",
  },
  tourDots: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.lg,
    flexWrap: "wrap",
    minHeight: MIN_TOUCH,
  },
  tourDotHit: { minHeight: MIN_TOUCH, justifyContent: "center" },
  tourDot: { height: 6, borderRadius: radius.full },
  tourDotOn: { width: 18, backgroundColor: colors.accent },
  tourDotOff: { width: 6, backgroundColor: colors.border },
  tourNav: { flexDirection: "row", gap: spacing.md, ...RTL },
});
