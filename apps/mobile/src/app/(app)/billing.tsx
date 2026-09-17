import { Platform, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle } from "phosphor-react-native";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";
import { getLocale, t } from "@/i18n";

interface BillingMe {
  plan: string;
  status: "trialing" | "active" | "past_due" | "cancelled" | "expired" | string;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  cancelledAt: string | null;
  amountEgp: number;
  isAccessActive: boolean;
  daysLeftInTrial: number | null;
  paymobConfigured: boolean;
}

interface Plan {
  key: string;
  labelAr: string;
  labelEn: string;
  taglineAr: string;
  taglineEn: string;
  monthlyEgp: number;
  purchasable: boolean;
  featuresAr: string[];
  featuresEn: string[];
}

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

/**
 * Port of app__billing.png — READ-ONLY on iOS, by design.
 *
 * App Store Review Guideline 3.1.1 forbids an iOS app from offering a way to
 * buy a subscription outside In-App Purchase, and Matgary bills through Paymob.
 * So on iOS this screen shows the plan, its status and its features, and
 * nothing that starts a purchase. The docs had this page marked DROP for that
 * reason; showing status without a buy button is allowed and is what the owner
 * actually needs to see. Android has no such rule and gets the action.
 */
export default function BillingScreen() {
  const isOwner = useSession((s) => s.me?.isOwner ?? false);

  const billing = useQuery({
    queryKey: ["billing-me"],
    queryFn: () => api.request<BillingMe>("/api/billing/me"),
    enabled: isOwner,
  });
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: async () => (await api.request<{ data: Plan[] }>("/api/plans", { auth: false })).data,
  });

  if (!isOwner) {
    return (
      <Screen title={t("app.billing.title")}>
        <EmptyState title={t("app.billing.ownerOnly")} />
      </Screen>
    );
  }

  const b = billing.data;
  const currentPlan = plans.data?.find((p) => p.key === b?.plan);

  const statusLine = (() => {
    if (!b) return null;
    if (b.status === "trialing" && b.daysLeftInTrial !== null)
      return t("mobile.billing.trialDaysLeft", { days: b.daysLeftInTrial });
    if (b.status === "past_due")
      return t("app.billing.statusLine.pastDueWarning");
    if (b.status === "cancelled" && b.currentPeriodEndsAt)
      return t("mobile.billing.activeUntil", { date: shortDate(b.currentPeriodEndsAt) });
    if (b.currentPeriodEndsAt) return t("mobile.billing.renewalOn", { date: shortDate(b.currentPeriodEndsAt) });
    return null;
  })();

  return (
    <Screen
      title={t("app.billing.title")}
      subtitle={t("app.billing.subtitle")}
      onRefresh={() => void billing.refetch()}
      refreshing={billing.isRefetching}
    >
      {b ? (
        <Card>
          <View style={styles.statusRow}>
            <CheckCircle
              size={22}
              color={b.isAccessActive ? colors.success : colors.danger}
            />
            <Text style={styles.statusTitle}>
              {STATUS()[b.status] ?? b.status}
              {currentPlan ? `  ·  ${planContent(currentPlan).label}` : ""}
            </Text>
          </View>
          {statusLine ? <Text style={styles.statusLine}>{statusLine}</Text> : null}
          {!b.paymobConfigured ? (
            <Text style={styles.note}>
              {t("app.billing.statusLine.paymobNotConfigured")}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {(plans.data ?? [])
        // The trial card is only meaningful while ON the trial; the web hides
        // it afterwards too. t("app.billing.comingSoon") is for plans not yet sellable, which the
        // trial is not — it is simply not purchasable.
        .filter((p) => p.key !== "trial" || b?.status === "trialing")
        .map((p) => {
        const isCurrent = p.key === b?.plan;
        const content = planContent(p);
        return (
          <Card key={p.key}>
            <Text style={styles.planName}>{content.label}</Text>
            <Text style={styles.planTagline}>{content.tagline}</Text>

            {p.purchasable ? (
              <View style={styles.priceRow}>
                <Text style={styles.price}>{p.monthlyEgp}</Text>
                <Text style={styles.priceUnit}>{t("app.billing.perMonth")}</Text>
              </View>
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

            {isCurrent ? (
              <Button label={t("app.billing.actions.currentPlan")} disabled onPress={() => {}} />
            ) : p.purchasable && Platform.OS === "android" ? (
              // TODO(phase-5): Paymob checkout. Web opens a hosted page; the
              // Android build can open the same URL in a browser.
              <Button label={t("app.billing.actions.subscribeNow")} variant="outline" disabled onPress={() => {}} />
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  statusTitle: { fontFamily: fonts.bold, fontSize: 17, color: colors.text, ...RTL_TEXT },
  statusLine: { fontFamily: fonts.regular, fontSize: 14, color: colors.text, marginTop: spacing.sm, ...RTL_TEXT },
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
  planName: { fontFamily: fonts.bold, fontSize: 22, color: colors.text, ...RTL_TEXT },
  planTagline: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, marginTop: 2, ...RTL_TEXT },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm, marginTop: spacing.lg },
  price: { fontFamily: fonts.bold, fontSize: 40, color: colors.accent, fontVariant: ["tabular-nums"] },
  priceUnit: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary },
  soon: { fontFamily: fonts.medium, fontSize: 15, color: colors.textSecondary, marginTop: spacing.lg, ...RTL_TEXT },
  features: { gap: spacing.md, marginTop: spacing.lg, marginBottom: spacing.xl },
  feature: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  featureText: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 15, color: colors.text, ...RTL_TEXT },
});
