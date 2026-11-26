import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ApiError, reports } from "@matgary/api-client";

import { api } from "@/api/client";
import { getLocale, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { BackLink } from "@/components/ui/BackLink";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReportBody } from "@/components/reports/ReportBody";
import { errorText } from "@/lib/errors";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";
import {
  SkeletonChart,
  SkeletonListRow,
  SkeletonStatCard,
} from "@/components/ui/skeleton";

/**
 * Monthly report — opened by a `report.monthly` push tap. The push carries
 * `?period=YYYY-MM`; the authoritative payload is fetched on mount. Title
 * + period render inline (no Screen title, no notification bell).
 */
export default function MonthlyReportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ period?: string | string[] }>();
  const period = useMemo(() => {
    const raw = Array.isArray(params.period) ? params.period[0] : params.period;
    return (raw ?? defaultPeriod()).trim();
  }, [params.period]);

  const q = useQuery({
    queryKey: ["reports", "monthly", period],
    queryFn: () => reports.getMonthly(api, period),
  });

  const title = t("mobile.reports.monthly.title");
  const subtitle = q.data?.window
    ? monthLabel(q.data.window.year, q.data.window.month)
    : t("mobile.reports.loadingPeriod", { period });

  const header = (
    <View style={styles.header}>
      <BackLink label={t("mobile.reports.back")} onPress={() => router.navigate("/")} />
    </View>
  );

  return (
    <Screen header={header}>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      {q.isPending && !q.data ? (
        <>
          <SkeletonStatCard />
          <SkeletonChart height={180} />
          <SkeletonListRow count={3} avatarSize={0} trailingWidth={48} height={48} />
        </>
      ) : q.error ? (
        <EmptyState
          title={t("mobile.reports.error.title")}
          hint={
            q.error instanceof ApiError && q.error.status === 400
              ? t("mobile.reports.error.invalidPeriod")
              : errorText(q.error, t("mobile.reports.error.generic"))
          }
        />
      ) : !q.data ? (
        <EmptyState title={t("mobile.reports.error.notFound")} />
      ) : (
        <ReportBody overview={q.data.overview} />
      )}
    </Screen>
  );
}

function defaultPeriod(): string {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(year: number, month: number): string {
  try {
    const d = new Date(year, month - 1, 1);
    const locale = getLocale() === "ar" ? "ar-EG" : "en-US";
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(d);
  } catch {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs, alignItems: "flex-start" },
  titleBlock: { gap: spacing.xs, marginBottom: spacing.md },
  title: { fontFamily: fonts.bold, fontSize: 28, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
});
