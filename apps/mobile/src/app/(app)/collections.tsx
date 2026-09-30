import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { CloudSlashIcon as CloudSlash } from "phosphor-react-native/src/icons/CloudSlash";
import { collections } from "@matgary/api-client";

import { api } from "@/api/client";
import {
  collectionKeys,
  localYmd,
  shiftYmd,
  useActiveBranchId,
  useCollectionAccess,
  useCollectionsFeatures,
} from "@/collections/queries";
import { inboxTabs, parseInboxParams, statusFilterFor, type InboxTab } from "@/collections/rules";
import { CollectionBadge } from "@/components/collections/CollectionBadge";
import { DailyTotals } from "@/components/collections/DailyTotals";
import { usePullRefresh } from "@/components/layout/usePullRefresh";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack, ChevronForward } from "@/components/ui/Chevron";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { money, shortDate } from "@/lib/format";
import { useGoBack } from "@/lib/nav";
import { useOffline } from "@/stores/offline";
import { useSession } from "@/stores/session";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

type Collection = collections.CollectionDTO;

const PAGE_SIZE = 50;

/** M1 renders four tabs; Credits is M2 (spec 08 step 24, order 21) — never shown before it is built. */
const M1_TABS = (tabs: InboxTab[]): InboxTab[] => tabs.filter((tab) => tab !== "credits");

/** LTR isolate for an all-Latin run (invoice id, "13:41", "1234") inside Arabic. */
function ltr(s: string): string {
  return `⁦${s}⁩`;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The Collections inbox (doc 15 spec 08 §4.7): every InstaPay / wallet
 * transfer the shop was told about, for the owner and staff with
 * `view_collections` — Pending (with "late only"), Confirmed, Rejected, and
 * the per-account daily totals. Rows open /collections/<id>, where the
 * decisions are.
 *
 * Route params are the web links of 03 §B.6 (`?status=pending&stale=1`,
 * `?tab=totals`), so a push tap opens the right tab. Online only: the
 * `collections` root is not snapshotted (a stale inbox would invite a wrong
 * decision). Branch-scoped through the query keys: a branch switch refetches.
 */
export default function CollectionsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const goBack = useGoBack("/more");
  const params = useLocalSearchParams<{ tab?: string; status?: string; stale?: string }>();
  const me = useSession((s) => s.me);
  const refreshMe = useSession((s) => s.refreshMe);
  const features = useCollectionsFeatures();
  const access = useCollectionAccess();
  const branchId = useActiveBranchId();
  const online = useOffline((s) => s.online);

  const tabs = M1_TABS(inboxTabs(features, access));
  const parsed = parseInboxParams(params, features);
  // A push tap on an already-open inbox changes the params, not the mount:
  // the user's choice holds only for the params it was made under.
  const paramKey = `${params.tab ?? ""}|${params.status ?? ""}|${params.stale ?? ""}`;
  const [choice, setChoice] = useState<{ key: string; tab: InboxTab; staleOnly: boolean } | null>(null);
  const current =
    choice && choice.key === paramKey
      ? choice
      : { key: paramKey, tab: parsed.tab === "credits" ? ("pending" as const) : parsed.tab, staleOnly: parsed.staleOnly };
  const tab = current.tab;
  const staleOnly = current.staleOnly;
  const setTab = (next: InboxTab) => setChoice({ ...current, tab: next });
  const setStaleOnly = (f: (v: boolean) => boolean) => setChoice({ ...current, staleOnly: f(current.staleOnly) });

  // Bearer permission claims can lag a change (R7): re-read /me on focus.
  useFocusEffect(
    useCallback(() => {
      void refreshMe();
    }, [refreshMe]),
  );

  const allowed = features.collections && access.canView;
  const status = statusFilterFor(tab);
  const listFilters = { status: status ?? undefined, stale: tab === "pending" && staleOnly ? true : undefined, branchId };
  const listQ = useInfiniteQuery({
    queryKey: collectionKeys.list(listFilters),
    enabled: allowed && tab !== "totals" && online,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      collections.listCollections(api, {
        status: listFilters.status,
        stale: listFilters.stale,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    getNextPageParam: (last, _pages, lastParam) =>
      last.nextCursor && last.nextCursor !== lastParam ? last.nextCursor : null,
  });
  const rows = useMemo(() => {
    const seen = new Map<string, Collection>();
    for (const page of listQ.data?.pages ?? []) for (const c of page.data) if (!seen.has(c.id)) seen.set(c.id, c);
    return [...seen.values()];
  }, [listQ.data]);
  const counts = listQ.data?.pages[0]?.counts ?? null;

  const today = localYmd();
  const [date, setDate] = useState(today);
  const summaryQ = useQuery({
    queryKey: collectionKeys.summary(date, branchId),
    enabled: allowed && tab === "totals" && online,
    queryFn: () => collections.getSummary(api, { date }),
  });

  const pull = usePullRefresh(
    () => (tab === "totals" ? summaryQ.refetch() : listQ.refetch()),
    tab === "totals" ? summaryQ.isRefetching : listQ.isRefetching && !listQ.isFetchingNextPage,
  );

  // ── full-screen states (§4.7 "Who") ────────────────────────────────────────
  if (!me) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (!features.collections || !access.canView) {
    const off = !features.collections;
    return (
      <View style={[styles.root, { paddingTop: insets.top + spacing.lg }]}>
        <View style={styles.content}>
          <BackCrumb onPress={goBack} />
          <Card>
            <View testID={off ? "collections-feature-off" : "collections-denied"} collapsable={false}>
              <EmptyState
                title={off ? t("app.collections.inbox.featureOff.title") : t("app.collections.inbox.denied.title")}
                hint={
                  off
                    ? access.canManage
                      ? t("app.collections.inbox.featureOff.ownerHint")
                      : t("app.collections.inbox.featureOff.staffHint")
                    : t("app.collections.inbox.denied.hint")
                }
              />
            </View>
          </Card>
        </View>
      </View>
    );
  }

  const header = (
    <View style={styles.headerWrap}>
      <BackCrumb onPress={goBack} />
      <View style={styles.titleBlock}>
        <Text style={styles.title}>{t("app.collections.inbox.title")}</Text>
        <Text style={styles.subtitle}>{t("app.collections.inbox.subtitle")}</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipsWrap}
        contentContainerStyle={styles.chips}
        keyboardShouldPersistTaps="handled"
      >
        {tabs.map((key) => (
          <Chip
            key={key}
            label={
              key === "pending" && counts && counts.pending > 0
                ? `${t("app.collections.inbox.tabs.pending")} · ${counts.pending}`
                : t(`app.collections.inbox.tabs.${key}`)
            }
            active={tab === key}
            compact
            onPress={() => setTab(key)}
            testID={`collections-tab-${key}`}
          />
        ))}
      </ScrollView>
      {tab === "pending" ? (
        <View style={styles.filterRow}>
          <Chip
            label={
              counts && counts.stale > 0
                ? `${t("app.collections.inbox.staleOnly")} · ${counts.stale}`
                : t("app.collections.inbox.staleOnly")
            }
            active={staleOnly}
            compact
            onPress={() => setStaleOnly((v) => !v)}
            testID="collections-stale-only"
          />
        </View>
      ) : null}
      {tab === "totals" ? (
        <View style={styles.dateRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("app.collections.totals.prevDay")}
            onPress={() => setDate((d) => shiftYmd(d, -1))}
            style={styles.dateBtn}
            testID="collections-totals-date-prev"
          >
            <ChevronBack size={18} color={colors.accent} />
          </Pressable>
          <View style={styles.dateLabelBox}>
            <Text style={styles.dateLabel}>
              {date === today ? t("app.collections.totals.today") : shortDate(`${date}T12:00:00`)}
            </Text>
            <Text style={styles.dateSub}>{t("app.collections.totals.title")}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("app.collections.totals.nextDay")}
            accessibilityState={{ disabled: date >= today }}
            disabled={date >= today}
            onPress={() => setDate((d) => (d >= today ? d : shiftYmd(d, 1)))}
            style={[styles.dateBtn, date >= today && styles.dateBtnDisabled]}
            testID="collections-totals-date-next"
          >
            <ChevronForward size={18} color={date >= today ? colors.border : colors.accent} />
          </Pressable>
        </View>
      ) : null}
      {!online ? (
        <Card>
          <View testID="collections-offline" collapsable={false} style={styles.offline}>
            <CloudSlash size={28} color={colors.warningStrong} weight="fill" />
            <EmptyState title={t("app.collections.inbox.offline.title")} hint={t("app.collections.inbox.offline.hint")} />
          </View>
        </Card>
      ) : tab === "totals" ? (
        summaryQ.isLoading ? (
          <ActivityIndicator color={colors.accent} style={styles.footer} />
        ) : summaryQ.isError ? (
          <ErrorCard text={errorText(summaryQ.error, t("app.collections.inbox.loadFailed"))} onRetry={() => void summaryQ.refetch()} />
        ) : summaryQ.data ? (
          <DailyTotals summary={summaryQ.data} showCredits={features.collectionsIngest} />
        ) : null
      ) : null}
    </View>
  );

  const listTab = tab !== "totals" && online;
  const empty = !listTab ? null : listQ.isLoading ? (
    <ActivityIndicator color={colors.accent} style={styles.footer} />
  ) : listQ.isError ? (
    <ErrorCard text={errorText(listQ.error, t("app.collections.inbox.loadFailed"))} onRetry={() => void listQ.refetch()} />
  ) : (
    <Card>
      <View testID="collections-empty" collapsable={false}>
        <EmptyState
          title={t(`app.collections.inbox.empty.${tab === "pending" ? "pending" : tab === "confirmed" ? "confirmed" : "rejected"}.title`)}
          hint={tab === "pending" ? t("app.collections.inbox.empty.pending.hint") : undefined}
        />
      </View>
    </Card>
  );

  const footer = listTab && listQ.isFetchingNextPage ? (
    <ActivityIndicator color={colors.accent} style={styles.footer} />
  ) : listTab && listQ.isFetchNextPageError ? (
    <Pressable accessibilityRole="button" onPress={() => void listQ.fetchNextPage()} style={styles.retry}>
      <Text style={styles.retryText}>{t("app.common.errorRetry")}</Text>
    </Pressable>
  ) : null;

  return (
    <View style={styles.root}>
      <FlashList
        data={listTab ? rows : []}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => (
          <CollectionRow c={item} onPress={() => router.push(`/collections/${encodeURIComponent(item.id)}`)} />
        )}
        ItemSeparatorComponent={Separator}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={() => {
          if (listTab && listQ.hasNextPage && !listQ.isFetchingNextPage) void listQ.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
        testID="collections-list"
      />
    </View>
  );
}

function BackCrumb({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("app.common.back")}
      hitSlop={8}
      style={styles.crumb}
      onPress={onPress}
      testID="back-link"
    >
      <ChevronBack size={16} color={colors.textSecondary} />
      <Text style={styles.crumbText}>{t("app.shell.more")}</Text>
    </Pressable>
  );
}

function ErrorCard({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <Card>
      <EmptyState title={text} compact />
      <Button label={t("app.common.retry")} variant="outline" onPress={onRetry} />
    </Card>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

/** One transfer (a "part") — spec 08 §4.7 row. */
function CollectionRow({ c, onPress }: { c: Collection; onPress: () => void }) {
  const where = c.sourceType === "settlement" ? t("app.collections.inbox.row.settlement") : c.invoiceId ? ltr(c.invoiceId) : "—";
  const meta = [
    shortDate(c.rungAt),
    ltr(timeOf(c.rungAt)),
    c.recordedBy?.name ? t("app.collections.inbox.row.recordedBy", { name: c.recordedBy.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const hints = [
    c.partsCount > 1 ? t("app.collections.inbox.row.part", { n: c.partNo, total: c.partsCount }) : null,
    c.payerPhoneLast4 ? `${t("app.collections.detail.payerLast4")} ${ltr(c.payerPhoneLast4)}` : null,
    c.payerReference ? `${t("app.collections.detail.reference")} ${ltr(c.payerReference)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`collections-row-${c.id}`}
    >
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <Text style={styles.amount}>{money(c.amount)}</Text>
          <View style={styles.rowBadges}>
            {c.isStale && c.status === "pending" ? (
              <Badge label={t("app.collections.inbox.staleBadge")} variant="outofstock" />
            ) : null}
            <CollectionBadge status={c.status} />
          </View>
        </View>
        <Text style={styles.account} numberOfLines={1}>
          {c.account
            ? `${c.account.label} · ${t(`app.collections.vocab.providers.${c.account.provider}`)}`
            : t("app.collections.inbox.row.noAccount")}
          {" · "}
          {t(`app.activityLabels.paymentMethods.${c.method}`)}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {where} · {meta}
        </Text>
        {hints ? (
          <Text style={styles.meta} numberOfLines={1}>
            {hints}
          </Text>
        ) : null}
        {c.status === "rejected" && c.rejectReason ? (
          <Text style={styles.meta} numberOfLines={1}>
            {t(`app.collections.vocab.reasons.${c.rejectReason}`)}
            {c.rejectOutcome ? ` · ${t(`app.collections.vocab.outcomes.${c.rejectOutcome}`)}` : ""}
          </Text>
        ) : null}
        {c.flags.length > 0 ? (
          <View style={styles.flags}>
            {c.flags.map((f) => (
              <Badge key={f} label={t(`app.collections.vocab.flags.${f}`)} variant="neutral" />
            ))}
          </View>
        ) : null}
      </View>
      <ChevronForward size={16} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  center: { alignItems: "center", justifyContent: "center" },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl * 3 },
  headerWrap: { gap: spacing.md, marginBottom: spacing.md },
  crumb: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: spacing.xs, minHeight: MIN_TOUCH },
  crumbText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  titleBlock: { gap: 2, alignItems: "flex-start" },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  chipsWrap: { marginHorizontal: -spacing.lg },
  chips: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg },
  filterRow: { flexDirection: "row", gap: spacing.sm },
  dateRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  dateBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dateBtnDisabled: { opacity: 0.5 },
  dateLabelBox: { flex: 1, alignItems: "center", gap: 2 },
  dateLabel: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, textAlign: "center" },
  dateSub: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, textAlign: "center" },
  offline: { alignItems: "center" },
  footer: { paddingVertical: spacing.xl },
  retry: { alignSelf: "center", minHeight: MIN_TOUCH, justifyContent: "center", paddingHorizontal: spacing.lg },
  retryText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 15, color: colors.accent },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, minHeight: MIN_TOUCH },
  rowPressed: { backgroundColor: colors.accentLight, borderRadius: radius.md },
  rowMain: { flex: 1, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  rowBadges: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexShrink: 1 },
  amount: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 17, color: colors.text, fontVariant: ["tabular-nums"] },
  account: { alignSelf: "flex-start", fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  meta: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  flags: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
});
