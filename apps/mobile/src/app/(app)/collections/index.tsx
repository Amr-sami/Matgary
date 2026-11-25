import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { CloudSlashIcon as CloudSlash } from "phosphor-react-native/src/icons/CloudSlash";
import { collectionCredits, collections } from "@matgary/api-client";

import { api } from "@/api/client";
import {
  collectionKeys,
  localYmd,
  shiftYmd,
  useActiveBranchId,
  useCollectionAccess,
  useCollectionsFeatures,
} from "@/collections/queries";
import {
  OPEN_CREDIT_STATES,
  creditsAccess,
  inboxTabs,
  parseInboxParams,
  statusFilterFor,
  type InboxTab,
} from "@/collections/rules";
import { CollectionBadge } from "@/components/collections/CollectionBadge";
import { CreditRow } from "@/components/collections/CreditRow";
import { DailyTotals } from "@/components/collections/DailyTotals";
import { PasteSheet, type PasteDone } from "@/components/collections/PasteSheet";
import { UnrecognisedSection } from "@/components/collections/UnrecognisedSection";
import { usePullRefresh } from "@/components/layout/usePullRefresh";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack, ChevronForward } from "@/components/ui/Chevron";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { countLabel, money, shortDate } from "@/lib/format";
import { useGoBack } from "@/lib/nav";
import { useOffline } from "@/stores/offline";
import { useSession } from "@/stores/session";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import {
  SkeletonListRow,
  SkeletonPaginationFooter,
  SkeletonStatCard,
} from "@/components/ui/skeleton";

type Collection = collections.CollectionDTO;
type Credit = collectionCredits.CreditDTO;
/** One FlashList for every list tab: collections (pending / confirmed / rejected) or credits (M2). */
type Item = { kind: "collection"; c: Collection } | { kind: "credit"; credit: Credit };

const PAGE_SIZE = 50;

/** The notice after a paste (08 §4.11): the count, with the Arabic 1 / 2 / 3–10 forms (`done.pasted{One,Two,Few}`). */
function pasteNotice(o: PasteDone): string {
  switch (o.notice) {
    case "added":
      return countLabel("app.collections.credits.done.pasted", o.added);
    case "already":
      return t("app.collections.credits.done.alreadyAdded");
    case "unrecognised":
      return t("app.collections.credits.done.notRecognised");
    default:
      return t("app.collections.credits.done.notCredit");
  }
}

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
 * `view_collections` — Pending (with "late only"), Credits (M2, only with
 * `features.collectionsIngest`), Confirmed, Rejected, and the per-account
 * daily totals. Rows open /collections/<id>, where the decisions are.
 *
 * Credits (M2, §4.11): the bank / wallet messages still waiting for a person
 * (`state=unmatched,held`), rows → /collections/credit/<id> (one-tap match,
 * ignore); `credits-paste` for `confirm_collections` / the owner; and, for
 * the OWNER only, the "Unrecognised messages" section under the list (ARCH
 * CR 8).
 *
 * Route params are the web links of 03 §B.6 (`?status=pending&stale=1`,
 * `?tab=totals`), so a push tap opens the right tab. Online only: the
 * `collections` root is not snapshotted (a stale inbox would invite a wrong
 * decision). Branch-scoped through the query keys: a branch switch refetches.
 */
export default function CollectionsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const goBack = useGoBack("/more");
  const params = useLocalSearchParams<{ tab?: string; status?: string; stale?: string }>();
  const me = useSession((s) => s.me);
  const refreshMe = useSession((s) => s.refreshMe);
  const features = useCollectionsFeatures();
  const access = useCollectionAccess();
  const branchId = useActiveBranchId();
  const online = useOffline((s) => s.online);

  const credits = creditsAccess(features, access);
  const tabs = inboxTabs(features, access).filter((key) => key !== "credits" || credits.canList);
  const parsed = parseInboxParams(params, features);
  // A push tap on an already-open inbox changes the params, not the mount:
  // the user's choice holds only for the params it was made under.
  const paramKey = `${params.tab ?? ""}|${params.status ?? ""}|${params.stale ?? ""}`;
  const [choice, setChoice] = useState<{ key: string; tab: InboxTab; staleOnly: boolean } | null>(null);
  const current =
    choice && choice.key === paramKey
      ? choice
      : { key: paramKey, tab: parsed.tab === "credits" && !credits.canList ? ("pending" as const) : parsed.tab, staleOnly: parsed.staleOnly };
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
    enabled: allowed && tab !== "totals" && tab !== "credits" && online,
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

  // ── credits (M2) ───────────────────────────────────────────────────────────
  const creditFilters = { state: OPEN_CREDIT_STATES, branchId };
  const creditsQ = useInfiniteQuery({
    queryKey: collectionKeys.credits(creditFilters),
    enabled: allowed && credits.canList && tab === "credits" && online,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      collectionCredits.listCredits(api, {
        state: ["unmatched", "held"],
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    getNextPageParam: (last, _pages, lastParam) =>
      last.nextCursor && last.nextCursor !== lastParam ? last.nextCursor : null,
  });
  const creditRows = useMemo(() => {
    const seen = new Map<string, Credit>();
    for (const page of creditsQ.data?.pages ?? []) for (const c of page.data) if (!seen.has(c.id)) seen.set(c.id, c);
    return [...seen.values()];
  }, [creditsQ.data]);

  // The paste sheet: remounted on every opening (a fresh form and a fresh Idempotency-Key).
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteMount, setPasteMount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const h = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(h);
  }, [notice]);

  const today = localYmd();
  const [date, setDate] = useState(today);
  const summaryQ = useQuery({
    queryKey: collectionKeys.summary(date, branchId),
    enabled: allowed && tab === "totals" && online,
    queryFn: () => collections.getSummary(api, { date }),
  });

  const activeQ = tab === "credits" ? creditsQ : listQ;
  const pull = usePullRefresh(
    () =>
      tab === "totals"
        ? summaryQ.refetch()
        : tab === "credits"
          ? Promise.all([creditsQ.refetch(), qc.invalidateQueries({ queryKey: collectionKeys.unrecognised() })])
          : listQ.refetch(),
    tab === "totals" ? summaryQ.isRefetching : activeQ.isRefetching && !activeQ.isFetchingNextPage,
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
      {tab === "credits" && credits.canPaste ? (
        <View style={styles.filterRow}>
          <View testID="credits-paste" collapsable={false}>
            <Button
              label={t("app.collections.credits.pasteSheet.title")}
              variant="outline"
              disabled={!online}
              onPress={() => {
                setPasteMount((n) => n + 1);
                setPasteOpen(true);
              }}
            />
          </View>
        </View>
      ) : null}
      {notice ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText} testID="credits-notice">
            {notice}
          </Text>
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
        summaryQ.isPending && !summaryQ.data ? (
          <SkeletonStatCard />
        ) : summaryQ.isError ? (
          <ErrorCard text={errorText(summaryQ.error, t("app.collections.inbox.loadFailed"))} onRetry={() => void summaryQ.refetch()} />
        ) : summaryQ.data ? (
          <DailyTotals summary={summaryQ.data} showCredits={features.collectionsIngest} />
        ) : null
      ) : null}
    </View>
  );

  const listTab = tab !== "totals" && online;
  const emptyKey = tab === "pending" ? "pending" : tab === "confirmed" ? "confirmed" : tab === "credits" ? "credits" : "rejected";
  const empty = !listTab ? null : activeQ.isPending && !activeQ.data ? (
    <SkeletonListRow count={5} avatarSize={40} trailingWidth={72} height={72} />
  ) : activeQ.isError ? (
    <ErrorCard text={errorText(activeQ.error, t("app.collections.inbox.loadFailed"))} onRetry={() => void activeQ.refetch()} />
  ) : (
    <Card>
      <View testID="collections-empty" collapsable={false}>
        <EmptyState
          title={t(`app.collections.inbox.empty.${emptyKey}.title`)}
          hint={tab === "pending" ? t("app.collections.inbox.empty.pending.hint") : undefined}
        />
      </View>
    </Card>
  );

  const pager = listTab && activeQ.isFetchingNextPage ? (
    <SkeletonPaginationFooter count={2} rowHeight={72} avatarSize={40} />
  ) : listTab && activeQ.isFetchNextPageError ? (
    <Pressable accessibilityRole="button" onPress={() => void activeQ.fetchNextPage()} style={styles.retry}>
      <Text style={styles.retryText}>{t("app.common.errorRetry")}</Text>
    </Pressable>
  ) : null;
  // The owner's Unrecognised messages sit under the credits list (ARCH CR 8).
  const footer =
    tab === "credits" && credits.canSeeUnrecognised && online ? (
      <View style={styles.footerStack}>
        {pager}
        <UnrecognisedSection online={online} />
      </View>
    ) : (
      pager
    );

  const items: Item[] = !listTab
    ? []
    : tab === "credits"
      ? creditRows.map((credit) => ({ kind: "credit" as const, credit }))
      : rows.map((c) => ({ kind: "collection" as const, c }));

  return (
    <View style={styles.root}>
      <FlashList
        data={items}
        keyExtractor={(item) => (item.kind === "credit" ? `k-${item.credit.id}` : `c-${item.c.id}`)}
        getItemType={(item) => item.kind}
        renderItem={({ item }) =>
          item.kind === "credit" ? (
            <CreditRow
              credit={item.credit}
              onPress={() => router.push(`/collections/credit/${encodeURIComponent(item.credit.id)}`)}
            />
          ) : (
            <CollectionRow c={item.c} onPress={() => router.push(`/collections/${encodeURIComponent(item.c.id)}`)} />
          )
        }
        ItemSeparatorComponent={Separator}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={() => {
          if (listTab && activeQ.hasNextPage && !activeQ.isFetchingNextPage) void activeQ.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
        testID="collections-list"
      />
      {credits.canPaste ? (
        <PasteSheet
          key={`paste-${pasteMount}`}
          visible={pasteOpen}
          onClose={() => setPasteOpen(false)}
          onDone={(outcome) => {
            setPasteOpen(false);
            setNotice(pasteNotice(outcome));
          }}
        />
      ) : null}
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
  footerStack: { gap: spacing.md, paddingTop: spacing.md },
  notice: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, backgroundColor: colors.successLight, borderColor: colors.successStrong },
  noticeText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.successStrong },
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
