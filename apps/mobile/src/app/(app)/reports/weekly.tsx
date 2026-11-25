import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ApiError, reports } from "@matgary/api-client";

import { api } from "@/api/client";
import { t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { BackLink } from "@/components/ui/BackLink";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReportBody } from "@/components/reports/ReportBody";
import { shortDate } from "@/lib/format";
import { errorText } from "@/lib/errors";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";
import {
  SkeletonChart,
  SkeletonListRow,
  SkeletonStatCard,
} from "@/components/ui/skeleton";

/**
 * Weekly report — opened by a `report.weekly` push tap. The push carries
 * `?period=YYYY-Www`; the authoritative payload is fetched on mount.
 *
 * Does NOT pass `title` to Screen because that block renders the shared
 * notification bell — a report is already a destination opened from the bell,
 * so re-showing it there is clutter. We render the title + period inline at
 * the top of the body instead.
 */
export default function WeeklyReportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ period?: string | string[] }>();
  const period = useMemo(() => {
    const raw = Array.isArray(params.period) ? params.period[0] : params.period;
    return (raw ?? defaultPeriod()).trim();
  }, [params.period]);

  const q = useQuery({
    queryKey: ["reports", "weekly", period],
    queryFn: () => reports.getWeekly(api, period),
  });

  const title = t("mobile.reports.weekly.title");
  const subtitle = q.data?.window
    ? `${shortDate(q.data.window.from)} – ${shortDate(q.data.window.to)}`
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
  // Last closed ISO week (Mon-Sun).
  const now = new Date();
  const day = now.getDay() || 7;
  const lastSunday = new Date(now);
  lastSunday.setDate(now.getDate() - day);
  const thursday = new Date(lastSunday);
  const d = lastSunday.getDay() || 7;
  thursday.setDate(lastSunday.getDate() + 4 - d);
  const year = thursday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const week = Math.ceil(((thursday.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs, alignItems: "flex-start" },
  titleBlock: { gap: spacing.xs, marginBottom: spacing.md },
  title: { fontFamily: fonts.bold, fontSize: 28, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
});
