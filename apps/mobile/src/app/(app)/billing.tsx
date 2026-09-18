import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { ApiError, me as meApi } from "@matgary/api-client";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { GlobeIcon as Globe } from "phosphor-react-native/src/icons/Globe";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { money, shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { getLocale, t, useLocale } from "@/i18n";

type Plan = meApi.BillingPlan;

const WEB_ORIGIN = "https://thestoro.com";

/**
 * Plan copy is API DATA (platform_plans, edited at /admin/plans), not
 * dictionary text — the server serves both languages side by side and the
 * web /billing page picks the sibling matching the locale. Same here. Read
 * at render (never at module scope) so a live locale switch re-picks.
 */
const planContent = (p: Plan): { label: string; tagline: string; features: string[] } =>
  getLocale() === "ar"
    ? { label: p.labelAr, tagline: p.taglineAr, features: p.featuresAr }
    : { label: p.labelEn, tagline: p.taglineEn, features: p.featuresEn };

/** dictionaries/ar.json app.billing.status.* */
const STATUS = (): Record<string, string> => ({
  trialing: t("app.billing.status.trialing"),
  active: t("app.billing.status.active"),
  past_due: t("app.billing.status.past_due"),
  cancelled: t("app.billing.status.cancelled"),
  expired: t("app.billing.status.expired"),
});

/** dictionaries/ar.json app.billing.attemptStatus.* */
const ATTEMPT_STATUS = (): Record<string, string> => ({
  pending: t("app.billing.attemptStatus.pending"),
  succeeded: t("app.billing.attemptStatus.succeeded"),
  failed: t("app.billing.attemptStatus.failed"),
});

/**
 * The two purchase paths, decided once per platform (doc 02 §6.4):
 *
 *   - `browser` (Android): POST /api/billing/subscribe → the server runs the
 *     3-step Paymob handshake and answers with the HOSTED checkout URL the web
 *     sets `window.location.href` to. The app opens that same URL in a Custom
 *     Tab; Paymob bounces to its configured return URL and the webhook
 *     settles the attempt, so the app re-reads billing when it regains focus.
 *   - `web` (iOS): App Store Review Guideline 3.1.1 forbids offering a way to
 *     buy a digital subscription outside In-App Purchase, and TheStoro bills
 *     through Paymob. So iOS shows the plan, its status and its features and
 *     NOTHING that starts a purchase — only a plain "manage on the web" row
 *     (no price, no "subscribe"/"buy" copy) opening the web billing page.
 */
const PURCHASE_PATH = Platform.select<"browser" | "web">({
  android: "browser",
  default: "web",
});

function checkoutErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    // 503 = PAYMOB_* unset on this server; the status card says the same.
    if (e.status === 503) return t("app.billing.statusLine.paymobNotConfigured");
    if (e.kind === "forbidden") return t("app.billing.ownerOnly");
    // 402 SUBSCRIPTION_REQUIRED — the server walled the very route that lifts
    // the wall (older server without allowSubscriptionRequired on subscribe).
    if (e.kind === "billing") return t("mobile.billing.subscriptionWalled");
  }
  return t("app.billing.errors.cantOpenCheckout");
}

/**
 * Port of app__billing.png — doc 02 §1.1 row 19 (RECOMPOSE) + §2.15.
 *
 * Also the landing page of the SUBSCRIPTION_REQUIRED wall (SuspensionRouter):
 * /api/billing/me is the one read the server still answers there, which is
 * why the status card must render from that call alone.
 */
export default function BillingScreen() {
  const isOwner = useSession((s) => s.me?.isOwner ?? false);
  const refreshMe = useSession((s) => s.refreshMe);
  const locale = useLocale((s) => s.locale);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  /** Set once a checkout tab was opened this visit — gates the foreground refetch. */
  const checkoutOpened = useRef(false);

  const billing = useQuery({
    queryKey: ["billing-me"],
    queryFn: () => meApi.getBilling(api),
    enabled: isOwner,
  });
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => meApi.listPlans(api),
  });

  /**
   * Re-read the subscription (and /me, which carries the wall flag) every
   * time the app comes back to the foreground after a checkout tab was
   * opened. Android's Custom Tab resolves openBrowserAsync with `opened`
   * immediately — there is no "dismissed" signal — so AppState is the only
   * hook for "the user is back from Paymob".
   */
  const refetchBilling = billing.refetch;

  /**
   * Back from Paymob (Custom Tab or the iOS web sheet). The wall lives in the
   * access token as `sub_ok`, and /api/v1/me ANDs the DB with that claim, so
   * re-reading /me with the SAME token would keep bouncing a freshly paid
   * owner to /billing until it expired (15 min). Re-mint first — the refresh
   * route derives `sub_ok` from the DB — then read /me and the subscription.
   */
  const settleCheckoutReturn = useCallback(async () => {
    await api.forceRefresh().catch(() => {});
    await Promise.all([refetchBilling(), refreshMe().catch(() => {})]);
  }, [refetchBilling, refreshMe]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active" || !checkoutOpened.current) return;
      // One-shot per checkout: later app switches must not re-show the notice.
      checkoutOpened.current = false;
      setNotice({ tone: "ok", text: t("mobile.billing.checkoutReturned") });
      void settleCheckoutReturn();
    });
    return () => sub.remove();
  }, [settleCheckoutReturn]);

  // Pre-warm the Custom Tab service so the hosted page opens without a beat.
  useEffect(() => {
    if (PURCHASE_PATH !== "browser") return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);

  const subscribe = useMutation({
    mutationFn: (plan: string) => meApi.startCheckout(api, plan),
    onSuccess: async ({ iframeUrl }) => {
      setNotice(null);
      checkoutOpened.current = true;
      try {
        // createTask:false keeps the tab inside the app's task, so the Back
        // gesture lands on this screen and AppState flips to "active".
        await WebBrowser.openBrowserAsync(iframeUrl, {
          createTask: false,
          showTitle: true,
          dismissButtonStyle: "close",
        });
      } catch {
        checkoutOpened.current = false;
        setNotice({ tone: "err", text: t("mobile.billing.openFailed") });
      }
    },
    onError: (e) => setNotice({ tone: "err", text: checkoutErrorText(e) }),
  });

  async function openWebBilling() {
    setNotice(null);
    try {
      await WebBrowser.openBrowserAsync(`${WEB_ORIGIN}/${locale}/billing`, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        dismissButtonStyle: "close",
      });
      // The sheet resolves on dismiss here (iOS) — whatever changed on the
      // web is worth a re-read, and a re-minted token lifts a cleared wall.
      void settleCheckoutReturn();
    } catch {
      setNotice({ tone: "err", text: t("mobile.billing.openFailed") });
    }
  }

  if (!isOwner) {
    return (
      <Screen title={t("app.billing.title")}>
        <EmptyState title={t("app.billing.ownerOnly")} />
      </Screen>
    );
  }

  const b = billing.data;
  /** First load, nothing to show yet — the web renders a spinner here too. */
  const loadingBilling = billing.isPending && !b;
  const currentPlan = plans.data?.find((p) => p.key === b?.plan);
  const lastAttempt = b?.history[0];

  const statusLine = (() => {
    if (!b) return null;
    if (b.status === "trialing" && b.daysLeftInTrial !== null)
      return t("mobile.billing.trialDaysLeft", { days: b.daysLeftInTrial });
    if (b.status === "past_due") return t("app.billing.statusLine.pastDueWarning");
    if (b.status === "cancelled" && b.currentPeriodEndsAt)
      return t("mobile.billing.activeUntil", { date: shortDate(b.currentPeriodEndsAt) });
    if (b.currentPeriodEndsAt)
      return t("mobile.billing.renewalOn", { date: shortDate(b.currentPeriodEndsAt) });
    return null;
  })();

  /** Per-plan action, one renderer per purchase path. */
  const planAction = Platform.select<(p: Plan, isCurrent: boolean) => ReactNode>({
    android: (p, isCurrent) => {
      if (isCurrent)
        return <Button label={t("app.billing.actions.currentPlan")} disabled onPress={() => {}} />;
      if (!p.purchasable) return null;
      return (
        <Button
          label={t("app.billing.actions.subscribeNow")}
          variant="outline"
          loading={subscribe.isPending}
          disabled={!b?.paymobConfigured}
          onPress={() => subscribe.mutate(p.key)}
        />
      );
    },
    default: (_p, isCurrent) =>
      isCurrent ? (
        <Button label={t("app.billing.actions.currentPlan")} disabled onPress={() => {}} />
      ) : null,
  });

  return (
    <Screen
      title={t("app.billing.title")}
      subtitle={t("app.billing.subtitle")}
      onRefresh={() => void refetchBilling()}
      refreshing={billing.isRefetching}
    >
      {notice ? (
        <Pressable onPress={() => setNotice(null)} accessibilityRole="button">
          <Text style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}>
            {notice.text}
          </Text>
        </Pressable>
      ) : null}

      {loadingBilling ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : null}

      {billing.isError && !b ? (
        <>
          <EmptyState title={t("app.common.errorRetry")} />
          <Button
            label={t("app.common.retry")}
            variant="outline"
            loading={billing.isRefetching}
            onPress={() => void refetchBilling()}
          />
        </>
      ) : null}

      {b ? (
        <Card>
          <View style={styles.statusRow}>
            <CheckCircle size={22} color={b.isAccessActive ? colors.success : colors.danger} />
            <Text style={styles.statusTitle}>
              {STATUS()[b.status] ?? b.status}
              {currentPlan ? `  ·  ${planContent(currentPlan).label}` : ""}
            </Text>
          </View>
          {statusLine ? <Text style={styles.statusLine}>{statusLine}</Text> : null}
          {lastAttempt?.status === "pending" ? (
            <Text style={styles.pending}>{t("mobile.billing.awaitingConfirmation")}</Text>
          ) : null}
          {PURCHASE_PATH === "browser" && !b.paymobConfigured ? (
            <Text style={styles.note}>{t("app.billing.statusLine.paymobNotConfigured")}</Text>
          ) : null}
        </Card>
      ) : null}

      {PURCHASE_PATH === "web" ? (
        <Card style={styles.manageCard}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={t("mobile.billing.manageOnWeb")}
            accessibilityHint={t("mobile.billing.manageOnWebHint")}
            onPress={() => void openWebBilling()}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.rowIcon}>
              <Globe size={20} color={colors.accent} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>{t("mobile.billing.manageOnWeb")}</Text>
              <Text style={styles.rowHint} numberOfLines={2}>
                {t("mobile.billing.manageOnWebHint")}
              </Text>
            </View>
            <ChevronForward size={16} color={colors.textSecondary} />
          </Pressable>
        </Card>
      ) : null}

      {(loadingBilling ? [] : (plans.data ?? []))
        // The trial card is only meaningful while ON the trial; the web hides
        // it afterwards too. t("app.billing.comingSoon") is for plans not yet
        // sellable, which the trial is not — it is simply not purchasable.
        .filter((p) => p.key !== "trial" || b?.status === "trialing")
        .map((p) => {
          // The server keeps `plan: "professional"` after past_due/cancelled/
          // expired, so plan alone would lock a lapsed owner — the one the
          // 402 wall lands here — behind a disabled "Current plan" button.
          // Same rule as the web (billing/page.tsx).
          const isCurrent = p.key === b?.plan && b?.status === "active";
          const content = planContent(p);
          return (
            <Card key={p.key}>
              <Text style={styles.planName}>{content.label}</Text>
              <Text style={styles.planTagline}>{content.tagline}</Text>

              {p.purchasable ? (
                // iOS shows plan name/tagline/features only (§6.4): a price
                // next to an outbound link reads as steering to a purchase.
                PURCHASE_PATH === "browser" ? (
                  <View style={styles.priceRow}>
                    <Text style={styles.price}>{p.monthlyEgp}</Text>
                    <Text style={styles.priceUnit}>{t("app.billing.perMonth")}</Text>
                  </View>
                ) : null
              ) : p.key !== "trial" ? (
                <Text style={styles.soon}>{t("app.billing.comingSoon")}</Text>
              ) : null}

              <View style={styles.features}>
                {content.features.map((f) => (
                  <View key={f} style={styles.feature}>
                    <CheckCircle size={18} color={colors.accent} />
                    <Text style={styles.featureText}>{f}</Text>
                  </View>
                ))}
              </View>

              {planAction(p, isCurrent)}
            </Card>
          );
        })}

      {b ? (
        <Card title={t("app.billing.history.title")}>
          {b.history.length === 0 ? (
            <Text style={styles.historyEmpty}>{t("app.billing.history.empty")}</Text>
          ) : (
            b.history.map((h, i) => (
              <View key={h.id} style={[styles.historyRow, i > 0 && styles.historyDivider]}>
                <View style={styles.rowBody}>
                  <Text style={styles.historyAmount}>{money(h.amountEgp)}</Text>
                  <Text style={styles.rowHint}>
                    {shortDate(h.settledAt ?? h.attemptedAt)}
                    {h.failureReason ? ` · ${h.failureReason}` : ""}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.historyStatus,
                    h.status === "succeeded"
                      ? styles.historyOk
                      : h.status === "failed"
                        ? styles.historyErr
                        : styles.historyPending,
                  ]}
                >
                  {ATTEMPT_STATUS()[h.status] ?? h.status}
                </Text>
              </View>
            ))
          )}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  notice: {
    fontFamily: fonts.medium,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
    ...RTL_TEXT,
  },
  noticeOk: { backgroundColor: colors.successLight, color: colors.successStrong },
  noticeErr: { backgroundColor: colors.dangerLight, color: colors.danger },
  loading: { marginTop: spacing.xxl },

  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  statusTitle: { flexShrink: 1, fontFamily: fonts.bold, fontSize: 17, color: colors.text, ...RTL_TEXT },
  statusLine: { fontFamily: fonts.regular, fontSize: 14, color: colors.text, marginTop: spacing.sm, ...RTL_TEXT },
  pending: { fontFamily: fonts.medium, fontSize: 13, color: colors.warning, marginTop: spacing.sm, ...RTL_TEXT },
  note: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    ...RTL_TEXT,
  },

  manageCard: { paddingVertical: 0, paddingHorizontal: 0 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH + spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
  },
  rowPressed: { backgroundColor: colors.neutralTint },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowHint: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: colors.textSecondary, ...RTL_TEXT },

  planName: { fontFamily: fonts.bold, fontSize: 22, color: colors.text, ...RTL_TEXT },
  planTagline: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, marginTop: 2, ...RTL_TEXT },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm, marginTop: spacing.lg },
  price: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 40, color: colors.accent, fontVariant: ["tabular-nums"] },
  priceUnit: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary },
  soon: { fontFamily: fonts.medium, fontSize: 15, color: colors.textSecondary, marginTop: spacing.lg, ...RTL_TEXT },
  features: { gap: spacing.md, marginTop: spacing.lg, marginBottom: spacing.xl },
  feature: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  featureText: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 15, color: colors.text, ...RTL_TEXT },

  historyEmpty: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  historyRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  historyDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  historyAmount: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"], ...RTL_TEXT },
  historyStatus: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13 },
  historyOk: { color: colors.successStrong },
  historyErr: { color: colors.danger },
  historyPending: { color: colors.warning },
});
