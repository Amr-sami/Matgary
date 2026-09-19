import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ClockIcon as Clock } from "phosphor-react-native/src/icons/Clock";
import { HandCoinsIcon as HandCoins } from "phosphor-react-native/src/icons/HandCoins";
import { StarIcon as Star } from "phosphor-react-native/src/icons/Star";
import { UsersIcon as Users } from "phosphor-react-native/src/icons/Users";
import { catalog, type CustomerSummary } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import { money, shortDate } from "@/lib/format";
import { customerRoute } from "@/lib/customer-phone";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Doc 02 §1.1 row 5 — RECOMPOSE as a *receivables* screen: debtors ranked by
 * outstanding balance with the age of their oldest unpaid invoice, because
 * "who owes me money, and for how long" is the question this tab answers.
 * The web's 4 KPI tiles collapse into one summary strip; the 5-way sort and
 * CSV export are gone.
 *
 * Data: GET /api/v1/customers — aggregated in SQL per (branch, phone), keyset
 * paginated, `q` searched server-side (§2.5: a phone must never download the
 * tenant's whole sales history). `oldestUnpaidAt` comes from the same row, so
 * the age is a subtraction, not a second fetch.
 *
 * Ranking caveat: the route sorts by last purchase and has no
 * `sort=outstanding` yet (§2.5), so the ranking, the Debtors filter and the
 * KPI strip are computed here over the pages loaded. To keep them honest the
 * screen auto-pages up to AUTO_PAGES (one customer row per line, so cheap even
 * on 3G) and, while a further page still exists, labels the strip as partial
 * and leaves "Show more" in place. When the server gains the sort/filter this
 * collapses back to a single page.
 *
 * The web's "top 5 loyal" tiles survive as one chip row (lifetime spend) under
 * the strip — spec row 5 wants them as a collapsed header, not gone.
 */

type Filter = "all" | "debtors";

const PAGE = 50;

/** Pages fetched automatically before the user has to tap "Show more":
 *  AUTO_PAGES × PAGE customers covers the vast majority of shops outright. */
const AUTO_PAGES = 8;

const TOP_N = 5;

/** Whole days since `iso`, clamped at 0 — "since 12 d". */
function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((now - ms) / 86_400_000));
}

/**
 * A phone is a LTR token: wrap it in a LTR isolate (LRI U+2066 … PDI U+2069)
 * so "+20…" keeps its plus in front inside an Arabic paragraph. Bare, the
 * leading "+" is a bidi neutral, takes the paragraph's RTL direction and
 * renders trailing — "201001234013+".
 */
function ltr(s: string): string {
  return `\u2066${s}\u2069`;
}

/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

function sinceLabel(days: number): string {
  return days === 0 ? t("mobile.customers.sinceToday") : t("mobile.customers.sinceDays", { n: days });
}

/** Debounce the search box so every keystroke is not a server round-trip. */
function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export default function CustomersScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);

  const list = useInfiniteQuery({
    queryKey: ["customers", { q }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      catalog.listCustomersPage(api, { q, cursor: pageParam, limit: PAGE }),
    getNextPageParam: (last) => last.nextCursor,
  });

  const all = useMemo(
    () => list.data?.pages.flatMap((p) => p.data) ?? [],
    [list.data],
  );

  // Page 1 carries the branch-wide count; later pages return null for it.
  const total = list.data?.pages[0]?.total ?? all.length;

  // Bounded auto-paging — see the header comment. Stops on error so a flaky
  // network cannot loop, and resets naturally when `q` changes the query key.
  const pagesLoaded = list.data?.pages.length ?? 0;
  const autoPaging = list.hasNextPage && pagesLoaded < AUTO_PAGES && !list.isError;
  const { fetchNextPage, isFetchingNextPage } = list;
  useEffect(() => {
    if (autoPaging && !isFetchingNextPage) void fetchNextPage();
  }, [autoPaging, isFetchingNextPage, pagesLoaded, fetchNextPage]);

  /** True while the numbers on screen do not yet cover every customer. */
  const partial = Boolean(list.hasNextPage);

  // Debtors first, the biggest balance on top; ties broken by the oldest
  // debt, then by lifetime spend so the rest of the list is still meaningful.
  const rows = useMemo(() => {
    const now = Date.now();
    const age = (c: CustomerSummary) => daysSince(c.oldestUnpaidAt, now) ?? -1;
    const base = filter === "debtors" ? all.filter((c) => c.outstanding > 0) : all;
    return [...base].sort(
      (a, b) =>
        b.outstanding - a.outstanding || age(b) - age(a) || b.totalSpend - a.totalSpend,
    );
  }, [all, filter]);

  const summary = useMemo(() => {
    const now = Date.now();
    let owed = 0;
    let debtors = 0;
    let oldest = 0;
    for (const c of all) {
      if (c.outstanding <= 0) continue;
      owed += c.outstanding;
      debtors += 1;
      oldest = Math.max(oldest, daysSince(c.oldestUnpaidAt, now) ?? 0);
    }
    return { owed, debtors, oldest };
  }, [all]);

  // The web's loyalty tiles, folded into one chip row: top-5 by lifetime spend.
  const topCustomers = useMemo(
    () =>
      all
        .filter((c) => c.totalSpend > 0)
        .sort((a, b) => b.totalSpend - a.totalSpend)
        .slice(0, TOP_N),
    [all],
  );
  const showTop = filter === "all" && q.length === 0 && topCustomers.length > 0;

  const filters = (): { key: Filter; label: string; testID: string }[] => [
    { key: "all", label: t("app.common.all"), testID: "customers-filter-all" },
    { key: "debtors", label: t("mobile.customers.filterDebtors"), testID: "customers-filter-debtors" },
  ];

  const emptyTitle =
    q.length > 0
      ? t("mobile.customers.noMatch")
      : filter === "debtors"
        ? t("mobile.customers.noDebtors")
        : t("mobile.customers.empty");
  const emptyHint =
    q.length > 0
      ? undefined
      : filter === "debtors"
        ? t("mobile.customers.noDebtorsHint")
        : t("mobile.customers.emptyHint");

  return (
    <Screen
      title={t("app.customers.title")}
      subtitle={
        all.length
          ? t(`mobile.customers.summary${countForm(total)}`, { n: total, owed: money(summary.owed) })
          : undefined
      }
      onRefresh={() => void list.refetch()}
      refreshing={list.isRefetching && !list.isFetchingNextPage}
    >
      <View testID="customers-search">
        <SearchField
          value={search}
          onChangeText={setSearch}
          placeholder={t("app.customers.search.placeholder")}
        />
      </View>

      {/* The web's four KPI tiles, collapsed into one strip — only the
          receivables numbers survive, because they are the ones that change
          what the shop does next. */}
      {all.length > 0 ? (
        <View testID="customers-summary" style={styles.kpis}>
          <View style={styles.kpiRow}>
            <Kpi
              icon={<HandCoins size={14} color={colors.warningStrong} />}
              label={t("app.customers.receivables.totalLabel")}
              value={money(summary.owed)}
              tone="warning"
            />
            <Kpi
              icon={<Users size={14} color={colors.textSecondary} />}
              label={t("mobile.customers.debtors")}
              value={String(summary.debtors)}
              testID="customers-debtors-count"
            />
            <Kpi
              icon={<Clock size={14} color={colors.textSecondary} />}
              label={t("app.customers.receivables.oldestLabel")}
              value={
                summary.debtors
                  ? t("app.customers.receivables.daysFormat", { n: summary.oldest })
                  : "—"
              }
            />
          </View>
          {partial ? (
            <View style={styles.partialRow}>
              {autoPaging ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
              <Text style={styles.partialText}>
                {t("mobile.customers.kpiPartial", { n: all.length })}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {showTop ? (
        <View style={styles.topWrap}>
          <View style={styles.topHead}>
            <Star size={14} color={colors.accent} />
            <Text style={styles.topTitle}>{t("mobile.customers.topCustomers")}</Text>
          </View>
          {/* Bleeds to the screen edge: a card sliced at the page gutter read as a bug. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -spacing.lg }} contentContainerStyle={[styles.topChips, { paddingHorizontal: spacing.lg }]}>
            {topCustomers.map((c) => (
              <Pressable
                key={c.phone}
                testID="customer-top-chip"
                accessibilityRole="button"
                accessibilityLabel={t("mobile.customers.profileOf", { name: c.name ?? c.phone })}
                onPress={() => router.push(customerRoute(c.phone) as never)}
                style={({ pressed }) => [styles.chip, pressed && styles.rowPressed]}
              >
                <Text numberOfLines={1} style={styles.chipName}>
                  {c.name ?? ltr(c.phone)}
                </Text>
                <Text numberOfLines={1} style={styles.chipSpend}>
                  {money(c.totalSpend)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View testID="customers-filter">
        <Segmented items={filters()} value={filter} onChange={setFilter} />
      </View>

      {list.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : list.isError ? (
        <View style={styles.errorWrap}>
          <EmptyState title={t("mobile.customers.loadFailed")} />
          <Button variant="outline" label={t("app.common.retry")} onPress={() => void list.refetch()} />
        </View>
      ) : (
        <View style={styles.list}>
          {rows.length === 0 ? (
            // Still reachable with "Show more" below: with the Debtors filter
            // on, an empty loaded set does not prove nobody owes anything
            // while further pages exist.
            <EmptyState title={emptyTitle} hint={emptyHint} />
          ) : null}
          {rows.map((c) => {
            const age = c.outstanding > 0 ? daysSince(c.oldestUnpaidAt) : null;
            return (
              // The phone is the route key AND can start with "+", which has to
              // survive the URL — customerRoute() normalises to E.164 and
              // encodes; the detail screen decodes and normalises the same way.
              <Pressable
                key={c.phone}
                testID="customer-row"
                accessibilityRole="button"
                accessibilityLabel={t("mobile.customers.profileOf", { name: c.name ?? c.phone })}
                onPress={() => router.push(customerRoute(c.phone) as never)}
                style={({ pressed }) => [
                  styles.row,
                  c.outstanding > 0 && styles.rowDebtor,
                  pressed && styles.rowPressed,
                ]}
              >
                <View style={styles.head}>
                  <Text numberOfLines={1} style={styles.name}>
                    {c.name ?? ltr(c.phone)}
                  </Text>
                  {c.outstanding > 0 ? (
                    <Text numberOfLines={1} style={styles.owed}>
                      {money(c.outstanding)}
                    </Text>
                  ) : null}
                </View>

                {c.outstanding > 0 ? (
                  <View style={styles.debtRow}>
                    {/* Status only — the amount already sits bold at the row's end;
                        printing it twice ~100pt apart reads as two debts. */}
                    <Badge label={t("mobile.customers.owingPill")} variant="outofstock" />
                    {age !== null ? (
                      <Badge label={sinceLabel(age)} variant={age >= 30 ? "outofstock" : "lowstock"} />
                    ) : null}
                  </View>
                ) : null}

                <Text style={styles.meta}>
                  {t(`mobile.customers.rowMeta${countForm(c.invoiceCount)}`, { phone: ltr(c.phone), n: c.invoiceCount, spend: money(c.totalSpend) })}
                </Text>
                <Text style={styles.meta}>
                  {t("mobile.customers.lastPurchase", { date: shortDate(c.lastPurchaseAt) })}
                </Text>
              </Pressable>
            );
          })}

          {autoPaging ? (
            <ActivityIndicator color={colors.accent} />
          ) : list.hasNextPage ? (
            <Button
              variant="outline"
              label={t("app.common.showMore")}
              loading={list.isFetchingNextPage}
              onPress={() => void list.fetchNextPage()}
            />
          ) : null}
        </View>
      )}
    </Screen>
  );
}

function Kpi({
  icon,
  label,
  value,
  tone,
  testID,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "warning";
  testID?: string;
}) {
  return (
    <View style={styles.kpi}>
      <View style={styles.kpiLabelRow}>
        {icon}
        <Text numberOfLines={1} style={styles.kpiLabel}>
          {label}
        </Text>
      </View>
      <Text
        testID={testID}
        numberOfLines={1}
        style={[styles.kpiValue, tone === "warning" && styles.kpiWarning]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  kpis: {
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    ...elevation.card,
  },
  kpi: { flex: 1, minWidth: 0, gap: 2 },
  kpiLabelRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  kpiLabel: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },
  kpiValue: {
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
    fontVariant: ["tabular-nums"],
    ...RTL_TEXT,
  },
  kpiWarning: { color: colors.warningStrong },
  kpiRow: { flexDirection: "row", gap: spacing.sm },
  partialRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  partialText: { flex: 1, minWidth: 0, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },

  topWrap: { gap: spacing.xs },
  topHead: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  topTitle: { fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  topChips: { gap: spacing.sm, paddingVertical: 2 },
  chip: {
    maxWidth: 160,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  chipName: { fontFamily: fonts.semibold, fontSize: 13, color: colors.text, ...RTL_TEXT },
  chipSpend: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, fontVariant: ["tabular-nums"], ...RTL_TEXT },

  errorWrap: { gap: spacing.md, alignItems: "center" },

  list: { gap: spacing.md },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
    ...elevation.card,
  },
  rowDebtor: { borderColor: colors.warningStrong },
  rowPressed: { backgroundColor: colors.accentLight },
  // space-between + a shrinkable name, like the dashboard rows: the amount sits
  // on the trailing edge whatever the name's width.
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  name: { flexShrink: 1, minWidth: 0, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  owed: {
    ...RTL_TEXT,
    flexShrink: 0,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.warningStrong,
    fontVariant: ["tabular-nums"],
  },
  debtRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
});
