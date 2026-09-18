import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { CoinsIcon as Coins } from "phosphor-react-native/src/icons/Coins";
import { ReceiptIcon as Receipt } from "phosphor-react-native/src/icons/Receipt";
import { sales as salesApi } from "@matgary/api-client";

import { api } from "@/api/client";
import { t } from "@/i18n";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { ChevronBack, ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { DateField } from "@/components/ui/DateField";
import { SearchField } from "@/components/ui/SearchField";
import { StatCard } from "@/components/ui/StatCard";
import { groupDigits, money, shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Doc 02 §1.1 row 2 (POS SPLIT): the web's /sales page is a POS form on top
 * of a ledger; on the phone the ledger is this screen and the POS stays on
 * the tab.
 *
 * GET /api/sales?paginated=1 has no date / payment / search filters — the web
 * ledger filters client-side too (apps/web/app/sales/page.tsx). So the list is
 * one cursor-paged infinite query, newest first, and every chip filters the
 * loaded rows. Paging stops as soon as a page's oldest row is older than the
 * selected range: "today" never downloads last month.
 *
 * Rows are invoice LINES; `groupInvoices` folds them into invoices. An invoice
 * can straddle a page boundary, so while a next page exists the last group is
 * held back until that page lands (it comes back complete).
 */

type RangeKey = "today" | "7d" | "30d" | "custom";
type Payment = salesApi.PaymentMethod;

const PAGE_SIZE = 100;
/** Keep pulling pages while the filtered list is this short (sparse filters). */
const MIN_VISIBLE = 12;
/** …but never more than this many pages without the user scrolling. */
const AUTO_PAGES = 8;

const RANGES = (): { key: RangeKey; label: string }[] => [
  { key: "today", label: t("app.sales.rangeLabel.today") },
  { key: "7d", label: t("app.sales.rangeLabel.7d") },
  { key: "30d", label: t("app.sales.rangeLabel.30d") },
  { key: "custom", label: t("mobile.salesHistory.customRange") },
];

/** Same labels the POS payment chips use (sales.tsx). */
const PAYMENT_LABELS = (): Record<Payment, string> => ({
  cash: t("app.catalog.payment.cash"),
  instapay: t("app.customers.settle.methods.instapay"),
  card: t("app.catalog.payment.card"),
  deferred: t("app.admin.sales.tenantDetail.paymentMethods.deferred"),
});
const PAYMENT_ORDER: Payment[] = ["cash", "instapay", "card", "deferred"];

function paymentLabel(p: Payment | null | undefined): string {
  return p ? PAYMENT_LABELS()[p] ?? p : "—";
}

/**
 * Date + time are one LTR token: wrapped in a LTR isolate (LRI U+2066 … PDI
 * U+2069) so "18/09/2026 06:15" keeps that order inside an Arabic paragraph.
 * Bare, the space between the two number runs takes the paragraph's RTL
 * direction and the time renders before the date — "06:15 18/09/2026".
 * Same helper as customers.tsx uses for phones.
 */
function ltr(s: string): string {
  return `\u2066${s}\u2069`;
}

/** "HH:MM" from an ISO string — no Intl on Hermes. */
function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
function endOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c;
}
/** "YYYY-MM-DD" from the DateField → local midnight, or null when malformed. */
function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function rangeBounds(
  key: RangeKey,
  from: string,
  to: string,
): { start: Date | null; end: Date | null } {
  const now = new Date();
  switch (key) {
    case "today":
      return { start: startOfDay(now), end: endOfDay(now) };
    case "7d": {
      const s = new Date(now);
      s.setDate(now.getDate() - 6);
      return { start: startOfDay(s), end: endOfDay(now) };
    }
    case "30d": {
      const s = new Date(now);
      s.setDate(now.getDate() - 29);
      return { start: startOfDay(s), end: endOfDay(now) };
    }
    case "custom": {
      const f = parseYmd(from);
      const tt = parseYmd(to);
      return { start: f ? startOfDay(f) : null, end: tt ? endOfDay(tt) : null };
    }
  }
}

export default function SalesHistoryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const branchId = useSession((s) => s.me?.branch?.id ?? null);

  const [range, setRange] = useState<RangeKey>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [payment, setPayment] = useState<Payment | null>(null);
  const [query, setQuery] = useState("");

  const q = useInfiniteQuery({
    // Branch is sent as a header by the client; it is in the key so a switch
    // in the shell refetches instead of showing the other branch's ledger.
    queryKey: ["sales", "history", branchId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      salesApi.listSalesPage(api, { cursor: pageParam, limit: PAGE_SIZE }),
    // A server that echoes the cursor it was sent would otherwise page for
    // ever; treat "same cursor again" as the end.
    getNextPageParam: (last, _pages, lastParam) =>
      last.nextCursor && last.nextCursor !== lastParam ? last.nextCursor : null,
  });
  const { isFetching, fetchNextPage } = q;

  // De-duplicate by line id so a repeated row can never double an invoice's
  // line count or totals in `groupInvoices`.
  const rows = useMemo(() => {
    const seen = new Map<string, salesApi.SaleRecord>();
    for (const page of q.data?.pages ?? []) for (const r of page.data) if (!seen.has(r.id)) seen.set(r.id, r);
    return [...seen.values()];
  }, [q.data]);

  const { start, end } = useMemo(
    () => rangeBounds(range, customFrom, customTo),
    [range, customFrom, customTo],
  );
  const fromBad = range === "custom" && customFrom.trim() !== "" && !parseYmd(customFrom);
  const toBad = range === "custom" && customTo.trim() !== "" && !parseYmd(customTo);

  // Newest first, so the last loaded row is the oldest. Once it predates the
  // range start there is nothing left on the server that could match.
  const oldestLoaded = rows.length ? new Date(rows[rows.length - 1]!.saleDate).getTime() : null;
  const moreInRange =
    q.hasNextPage && (start === null || oldestLoaded === null || oldestLoaded >= start.getTime());

  const invoices = useMemo(() => {
    const grouped = salesApi.groupInvoices(rows);
    // The last group may be cut by the page boundary; it returns whole with
    // the next page. When there is no next page every group is complete.
    const complete = q.hasNextPage && grouped.length > 1 ? grouped.slice(0, -1) : grouped;
    const needle = query.trim().toLowerCase();
    return complete.filter((inv) => {
      const at = new Date(inv.saleDate).getTime();
      if (start && at < start.getTime()) return false;
      if (end && at > end.getTime()) return false;
      if (payment && inv.paymentMethod !== payment) return false;
      if (needle) {
        const hay = `${inv.invoiceId ?? ""} ${inv.customerName ?? ""} ${inv.customerPhone ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [rows, q.hasNextPage, start, end, payment, query]);

  const totalCount = invoices.length;
  const totalSum = useMemo(() => invoices.reduce((s, inv) => s + inv.netTotal, 0), [invoices]);

  // A sparse filter (one card sale in a cash shop) leaves the list too short
  // for onEndReached to ever fire; top it up, bounded, until it can scroll.
  const pagesLoaded = q.data?.pages.length ?? 0;
  useEffect(() => {
    if (isFetching || !moreInRange) return;
    if (invoices.length < MIN_VISIBLE && pagesLoaded < AUTO_PAGES) void fetchNextPage();
  }, [isFetching, fetchNextPage, moreInRange, invoices.length, pagesLoaded]);

  const open = (inv: salesApi.Invoice) => {
    const first = inv.lines[0];
    if (!first) return;
    // Hand the detail screen the lines we already hold so it renders at once
    // (same key it fetches under when opened from a deep link).
    // `invoices` already holds back a page-cut last group, so this one is whole.
    const primed: salesApi.InvoiceLinesResult = { lines: inv.lines, complete: true };
    qc.setQueryData(["sales", "invoice", inv.key], primed);
    router.push(`/sales/${encodeURIComponent(first.id)}`);
  };

  const header = (
    <View style={styles.headerWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("app.common.back")}
        hitSlop={8}
        style={styles.crumb}
        onPress={() => router.navigate("/sales")}
      >
        <ChevronBack size={16} color={colors.textSecondary} />
        <Text style={styles.crumbText}>{t("app.shell.primary.sales")}</Text>
      </Pressable>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>{t("mobile.salesHistory.title")}</Text>
        <Text style={styles.subtitle}>{t("mobile.salesHistory.subtitle")}</Text>
      </View>

      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t("mobile.salesHistory.searchPlaceholder")}
      />

      <View style={styles.chips}>
        {RANGES().map((r) => (
          <Chip key={r.key} label={r.label} active={range === r.key} onPress={() => setRange(r.key)} />
        ))}
      </View>
      {range === "custom" ? (
        <View style={styles.dateRow}>
          <View style={styles.dateCol}>
            <DateField
              label={t("app.activity.filters.fromLabel")}
              value={customFrom || null}
              onChange={setCustomFrom}
              max={customTo || undefined}
            />
            {fromBad ? <Text style={styles.fieldError}>{t("mobile.activity.invalidDate")}</Text> : null}
          </View>
          <View style={styles.dateCol}>
            <DateField
              label={t("app.activity.filters.toLabel")}
              value={customTo || null}
              onChange={setCustomTo}
              min={customFrom || undefined}
            />
            {toBad ? <Text style={styles.fieldError}>{t("mobile.activity.invalidDate")}</Text> : null}
          </View>
        </View>
      ) : null}

      <View style={styles.chips}>
        <Chip label={t("mobile.salesHistory.paymentAll")} active={payment === null} onPress={() => setPayment(null)} />
        {PAYMENT_ORDER.map((p) => (
          <Chip
            key={p}
            label={PAYMENT_LABELS()[p]}
            active={payment === p}
            onPress={() => setPayment(payment === p ? null : p)}
          />
        ))}
      </View>

      <View style={styles.stats}>
        <StatCard title={t("mobile.salesHistory.invoices")} value={groupDigits(totalCount)} icon={Receipt} />
        <StatCard title={t("mobile.salesHistory.total")} value={money(totalSum)} icon={Coins} color="success" />
      </View>
      {moreInRange && rows.length > 0 ? (
        // The cards count only the pages loaded so far; say so until the
        // range is fully paged in.
        <Text style={styles.partialHint}>{t("mobile.salesHistory.totalsPartial")}</Text>
      ) : null}
    </View>
  );

  const footer = q.isFetchingNextPage ? (
    <ActivityIndicator color={colors.accent} style={styles.footer} />
  ) : q.isFetchNextPageError ? (
    // Network dropped mid-scroll: the list would otherwise just stop.
    <Pressable accessibilityRole="button" onPress={() => void fetchNextPage()} style={styles.retry}>
      <Text style={styles.retryText}>{t("app.common.errorRetry")}</Text>
    </Pressable>
  ) : !q.isLoading && rows.length > 0 && !moreInRange ? (
    <Text style={styles.endText}>{t("mobile.salesHistory.endOfList")}</Text>
  ) : null;

  const empty = q.isLoading ? (
    <ActivityIndicator color={colors.accent} style={styles.footer} />
  ) : q.isError ? (
    <Card>
      <EmptyState title={t("app.common.errorRetry")} />
      <Pressable accessibilityRole="button" onPress={() => void q.refetch()} style={styles.retry}>
        <Text style={styles.retryText}>{t("app.common.retry")}</Text>
      </Pressable>
    </Card>
  ) : moreInRange ? (
    // The auto-fill effect is still paging towards the range.
    <ActivityIndicator color={colors.accent} style={styles.footer} />
  ) : (
    <Card>
      <EmptyState title={t("mobile.salesHistory.empty")} hint={t("mobile.salesHistory.emptyHint")} />
    </Card>
  );

  return (
    <View style={styles.root}>
      <FlashList
        data={invoices}
        keyExtractor={(inv) => inv.key}
        renderItem={({ item }) => <InvoiceRow inv={item} onPress={() => open(item)} />}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        ItemSeparatorComponent={Separator}
        onEndReached={() => {
          if (moreInRange && !q.isFetchingNextPage) void q.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => void q.refetch()} />
        }
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
        testID="sales-history-list"
      />
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

function InvoiceRow({ inv, onPress }: { inv: salesApi.Invoice; onPress: () => void }) {
  const customer = inv.customerName?.trim() || inv.customerPhone || t("app.sales.deferred.noName");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`sales-history-row-${inv.key}`}
    >
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <Text style={styles.invoice} numberOfLines={1}>
            {inv.invoiceId ?? inv.lines[0]?.productName ?? "—"}
          </Text>
          <Text style={[styles.total, inv.fullyReturned && styles.totalReturned]}>{money(inv.netTotal)}</Text>
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {ltr(`${shortDate(inv.saleDate)} ${timeOf(inv.saleDate)}`)} · {customer} ·{" "}
          {t("mobile.salesHistory.lineCount", { n: inv.lines.length })}
        </Text>
        <View style={styles.badges}>
          <Badge label={paymentLabel(inv.paymentMethod)} variant={inv.paymentMethod === "deferred" ? "lowstock" : "accent"} />
          {inv.fullyReturned ? (
            <Badge label={t("app.sales.status.returned")} variant="outofstock" />
          ) : inv.hasReturn ? (
            <Badge label={t("mobile.salesHistory.partialReturn")} variant="lowstock" />
          ) : null}
          {inv.outstanding > 0 ? (
            <Badge label={t("mobile.customers.remaining", { amount: money(inv.outstanding) })} variant="outofstock" />
          ) : null}
        </View>
      </View>
      <ChevronForward size={16} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl * 2 },
  headerWrap: { gap: spacing.md, marginBottom: spacing.md },
  crumb: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
  },
  crumbText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  titleBlock: { gap: 2, alignItems: "flex-start" },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  dateRow: { flexDirection: "row", gap: spacing.md },
  dateCol: { flex: 1 },
  fieldError: {
    alignSelf: "flex-start",
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.danger,
    marginTop: spacing.xs,
    ...RTL_TEXT,
  },
  stats: { flexDirection: "row", gap: spacing.md },
  partialHint: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    minHeight: MIN_TOUCH,
  },
  rowPressed: { backgroundColor: colors.accentLight, borderRadius: radius.md },
  // A stretched Text keeps its glyphs on the left edge in RTL (Yoga places
  // boxes by `direction`; the text engine does not follow). So no Text in
  // the row is stretched: rowTop shrinks the invoice to content and the
  // column children below sit at flex-start — right in Arabic, left in
  // English — the way titleBlock does for the title.
  rowMain: { flex: 1, gap: spacing.xs },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  invoice: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  total: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 16, color: colors.text, fontVariant: ["tabular-nums"] },
  totalReturned: { color: colors.textSecondary, textDecorationLine: "line-through" },
  meta: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  footer: { paddingVertical: spacing.xl },
  endText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: spacing.xl,
  },
  retry: { alignSelf: "center", minHeight: MIN_TOUCH, justifyContent: "center", paddingHorizontal: spacing.lg },
  retryText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 15, color: colors.accent },
});
