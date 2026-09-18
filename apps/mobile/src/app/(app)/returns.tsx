import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowCounterClockwise } from "phosphor-react-native";
import { ApiError, catalog, type ListEnvelope, type SaleLine } from "@matgary/api-client";

import { api } from "@/api/client";
import { isRTL, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { StatCard } from "@/components/ui/StatCard";
import { money, shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Doc 02 §1.1 row 13 — Returns, RECOMPOSE: the web is a month-count tile plus
 * a 600px table with no filters. Native gets the tile, a date range
 * (today / 7d / 30d / custom), invoice search, and a card list.
 *
 * What the server offers (apps/web/app/api/returns/route.ts): GET takes
 * `?days=N` / `?all=1` only — `listReturns` in lib/repo/operations.ts accepts
 * a single `since` cutoff, no `to`, no invoice filter, no pagination. So the
 * range is sent as a coarse `days=` window and the exact [from, to] plus the
 * invoice search are applied here. There is nothing to paginate.
 *
 * A return row carries `saleId` but no invoice number or money value; both are
 * joined from /api/sales client-side (the same list the take-return picker
 * shows). Rows whose sale falls outside the sales window degrade to name +
 * qty + date.
 *
 * `?saleId=` (from a sales row's "return" action) preselects that line in the
 * take-return modal. If the line is not in the recent list it is fetched by id.
 */

/** Shape /api/returns actually answers (packages/api-client ReturnRecord is stale). */
interface ReturnRow {
  id: string;
  saleId: string;
  productId: string;
  productName: string;
  returnedQuantity: number;
  returnDate: string;
  reason: string | null;
}

/** /api/sales rows carry these on top of SaleLine; the client type omits them. */
type SaleRow = SaleLine & { isReturned?: boolean; returnedQuantity?: number | null };

type RangeKey = "today" | "7d" | "30d" | "custom";
const RANGES = (): { key: RangeKey; label: string }[] => [
  { key: "today", label: t("app.dateRange.today") },
  { key: "7d", label: t("app.dateRange.7d") },
  { key: "30d", label: t("app.dateRange.30d") },
  { key: "custom", label: t("app.dateRange.custom") },
];

const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 730; // resolveSinceWindow clamps here

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
/** "YYYY-MM-DD" -> local midnight, or null when malformed / impossible. */
function parseDay(s: string): Date | null {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}
function toDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A sale line can be returned ONCE. `recordReturn` (lib/repo/operations.ts)
 * sets `isReturned` and OVERWRITES `returnedQuantity` — no accumulation, and
 * stock is re-credited on every call — so, like the web's SalesTableRow, any
 * `isReturned` line is closed for returns and a fresh line's cap is the full
 * `quantitySold`. Partial "x of y left" is not a state the server can hold.
 */
function returnable(l: SaleRow): number {
  return l.isReturned ? 0 : l.quantitySold;
}

/**
 * Same helper as suppliers.tsx. The store's messageFor() has no `forbidden`
 * case and falls back to sign-in copy, which is wrong for a save.
 */
function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  // The returns route answers 400 with an Arabic sentence ("البيع غير موجود").
  if (error.code && /[؀-ۿ]/.test(error.code)) return error.code;
  switch (error.kind) {
    case "offline":
      return t("mobile.common.offline");
    case "timeout":
      return t("mobile.common.timeout");
    case "forbidden":
      return t("mobile.common.forbidden");
    case "validation":
      return t("mobile.common.checkInput");
    case "rateLimited":
      return t("mobile.common.tooManyAttempts");
    case "billing":
      return t("mobile.common.subscriptionInactive");
    case "server":
      return t("mobile.common.serverError");
    default:
      return fallback;
  }
}

/**
 * "INV-… · 1 قطعة · 17/09/2026" — invoice, count and date as ONE Text
 * scrambles in Arabic: a paragraph's base direction comes from its first
 * strong character (the Latin "I"), so the line lays out LTR — left-aligned,
 * with the neutrals around the Arabic word reordered ("1 17/09/2026 · قطعة").
 * Yoga's `direction` does not reach inside a paragraph. So every piece is its
 * own Text in a row: Yoga orders the pieces by the root direction, and each
 * piece is a single script that resolves on its own ("1 قطعة" → RTL, the
 * invoice and the date → LTR). No bidi marks, no per-text writingDirection.
 */
function MetaLine({ invoice, count, date }: { invoice?: string | null; count: number; date?: string | null }) {
  return (
    <View style={styles.metaRow}>
      {invoice ? (
        <Text numberOfLines={1} style={[styles.meta, styles.metaInvoice]}>
          {invoice}
        </Text>
      ) : null}
      {invoice ? <Text style={styles.meta}>{"·"}</Text> : null}
      <Text style={styles.meta}>{t("mobile.common.pieces", { n: count })}</Text>
      {date ? <Text style={styles.meta}>{"·"}</Text> : null}
      {date ? <Text style={styles.meta}>{shortDate(date)}</Text> : null}
    </View>
  );
}

export default function ReturnsScreen() {
  const qc = useQueryClient();
  const router = useRouter();
  const params = useLocalSearchParams<{ saleId?: string | string[]; invoiceId?: string | string[] }>();
  const preselectId = (Array.isArray(params.saleId) ? params.saleId[0] : params.saleId) || null;
  const me = useSession((s) => s.me);
  // POST /api/returns is gated on manage_returns (owners bypass). Hiding the
  // affordance saves a cashier filling the whole form only to get a 403.
  const canReturn = !!me && (me.isOwner || me.permissions.includes("manage_returns"));

  // ---- range -------------------------------------------------------------
  const [range, setRange] = useState<RangeKey>("30d");
  const [fromText, setFromText] = useState(() => toDay(new Date(Date.now() - 30 * DAY)));
  const [toText, setToText] = useState(() => toDay(new Date()));
  const [search, setSearch] = useState("");

  const now = new Date();
  const todayStart = startOfDay(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Presets end at the END of today, not "now": a memoised `now` would hide a
  // return recorded a minute after the screen rendered.
  const todayMs = todayStart.getTime();
  const bounds = useMemo((): { from: Date; to: Date; invalid: boolean } => {
    const endOfToday = new Date(todayMs + DAY - 1);
    if (range === "today") return { from: new Date(todayMs), to: endOfToday, invalid: false };
    if (range === "7d") return { from: new Date(todayMs - 6 * DAY), to: endOfToday, invalid: false };
    if (range === "30d") return { from: new Date(todayMs - 29 * DAY), to: endOfToday, invalid: false };
    const f = parseDay(fromText);
    const tt = parseDay(toText);
    if (!f || !tt || f > tt) return { from: new Date(todayMs), to: endOfToday, invalid: true };
    return { from: f, to: new Date(tt.getTime() + DAY - 1), invalid: false };
  }, [range, fromText, toText, todayMs]);

  // Server window: one `days=` cutoff wide enough for BOTH the selected range
  // and the month tile; the exact bounds are applied below. Custom with an
  // unparseable "from" falls back to full history so the user still sees rows.
  const monthDays = Math.ceil((now.getTime() - monthStart.getTime()) / DAY) + 1;
  // A window the server would clamp (list-window.ts caps `days` at MAX_DAYS)
  // also goes to full history: otherwise rows between `from` and the clamp
  // would be silently missing while the exact filter still claimed them.
  const rawDays = bounds.invalid ? null : Math.ceil((now.getTime() - bounds.from.getTime()) / DAY) + 1;
  const rangeDays = rawDays !== null && rawDays > MAX_DAYS ? null : rawDays;
  const returnsQuery = rangeDays === null ? "all=1" : `days=${Math.max(1, Math.max(rangeDays, monthDays))}`;
  // Sales predate their returns; give the join a margin behind the returns window.
  const salesQuery = rangeDays === null ? "all=1" : `days=${Math.min(MAX_DAYS, Math.max(rangeDays, monthDays) + 90)}`;

  const q = useQuery({
    queryKey: ["returns", returnsQuery],
    queryFn: async () => (await api.request<ListEnvelope<ReturnRow>>(`/api/returns?${returnsQuery}`)).data ?? [],
  });
  const sales = useQuery({
    queryKey: ["sales", "for-returns", salesQuery],
    queryFn: async () => (await api.request<ListEnvelope<SaleRow>>(`/api/sales?${salesQuery}`)).data ?? [],
  });
  const saleById = useMemo(() => {
    const m = new Map<string, SaleRow>();
    for (const s of sales.data ?? []) m.set(s.id, s);
    return m;
  }, [sales.data]);

  // ---- derived list --------------------------------------------------------
  const all = q.data ?? [];
  const monthRows = all.filter((r) => new Date(r.returnDate) >= monthStart);
  const amountOf = (r: ReturnRow) => {
    const s = saleById.get(r.saleId);
    return s ? r.returnedQuantity * s.pricePerUnit : null;
  };
  const monthTotal = monthRows.reduce((sum, r) => sum + (amountOf(r) ?? 0), 0);

  const needle = search.trim().toLowerCase();
  const rows = all.filter((r) => {
    const d = new Date(r.returnDate);
    if (d < bounds.from || d > bounds.to) return false;
    if (!needle) return true;
    const inv = saleById.get(r.saleId)?.invoiceId?.toLowerCase() ?? "";
    return inv.includes(needle) || r.productName.toLowerCase().includes(needle);
  });
  const rangeTotal = rows.reduce((sum, r) => sum + (amountOf(r) ?? 0), 0);

  // ---- take-return modal ---------------------------------------------------
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState<SaleRow | null>(null);
  const [pick, setPick] = useState("");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  // ?saleId= preselect. Consumed once per id so re-focusing the tab does not
  // reopen the modal after the cashier closed it. closeModal clears the param,
  // and the effect resets `consumed` once it is gone, so the SAME id pushed
  // again from the sale detail opens again.
  const consumed = useRef<string | null>(null);
  const preselect = useQuery({
    queryKey: ["sale", preselectId],
    queryFn: async () => (await api.request<{ data: SaleRow }>(`/api/sales/${preselectId}`)).data,
    enabled: !!preselectId && !saleById.has(preselectId) && consumed.current !== preselectId,
    retry: false,
  });
  const preselected = preselectId ? (saleById.get(preselectId) ?? preselect.data ?? null) : null;
  useEffect(() => {
    if (!preselectId) {
      consumed.current = null;
      return;
    }
    if (consumed.current === preselectId) return;
    if (!me) return; // session still hydrating
    if (!canReturn) {
      // Nothing to open for a user who cannot record returns; swallow the param.
      consumed.current = preselectId;
      return;
    }
    if (preselected) {
      consumed.current = preselectId;
      setLine(preselected);
      setQty("1");
      setError(preselected.isReturned ? t("mobile.returns.fullyReturned") : null);
      setOpen(true);
    } else if (preselect.isError) {
      consumed.current = preselectId;
      setLine(null);
      // Only a 404 means the sale does not exist; offline / timeout / 5xx get
      // their own copy, and the picker underneath stays usable either way.
      const e = preselect.error;
      const notFound = e instanceof ApiError && (e.kind === "notFound" || e.status === 404);
      setError(notFound ? t("mobile.returns.saleNotFound") : errorMessage(e, t("mobile.returns.saleLoadFailed")));
      setOpen(true);
    }
  }, [preselectId, preselected, preselect.isError, preselect.error, me, canReturn]);

  const create = useMutation({
    mutationFn: () =>
      catalog.createReturn(api, {
        saleId: line!.id,
        productId: line!.productId,
        returnedQuantity: Number(qty),
        reason: reason.trim(),
      }),
    onSuccess: () => {
      closeModal();
      void qc.invalidateQueries({ queryKey: ["returns"] });
      void qc.invalidateQueries({ queryKey: ["sales"] });
      void qc.invalidateQueries({ queryKey: ["sale"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setError(errorMessage(e, t("mobile.returns.saveFailed"))),
  });

  function closeModal() {
    setOpen(false);
    setLine(null);
    setPick("");
    setQty("1");
    setReason("");
    setError(null);
    // Drop ?saleId= so the next push of the same id is a fresh preselect (the
    // effect above resets `consumed` once the param is actually gone — resetting
    // it here would race the still-present param and reopen the modal).
    if (preselectId) router.setParams({ saleId: undefined, invoiceId: undefined });
  }

  const maxQty = line ? returnable(line) : 0;
  const n = Number(qty);
  const canSubmit = line !== null && Number.isInteger(n) && n >= 1 && n <= maxQty && reason.trim().length > 0 && !create.isPending;

  const pickNeedle = pick.trim().toLowerCase();
  const pickable = (sales.data ?? [])
    .filter((l) => !l.isReturned)
    .filter((l) => !pickNeedle || l.invoiceId.toLowerCase().includes(pickNeedle) || l.productName.toLowerCase().includes(pickNeedle))
    .slice(0, 40);

  const refresh = () => {
    void q.refetch();
    void sales.refetch();
  };

  return (
    <Screen
      title={t("app.returns.title")}
      subtitle={rows.length ? t("mobile.returns.summary", { n: rows.length, total: money(rangeTotal) }) : undefined}
      onRefresh={refresh}
      refreshing={q.isRefetching || sales.isRefetching}
    >
      <StatCard
        title={t("app.returns.monthLabel")}
        value={monthRows.length}
        icon={ArrowCounterClockwise}
        color="danger"
        subtitle={monthRows.length ? t("mobile.returns.monthTotal", { total: money(monthTotal) }) : undefined}
      />

      {canReturn ? <Button label={t("app.sales.returnModal.title")} onPress={() => setOpen(true)} /> : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {RANGES().map((r) => (
          <Chip key={r.key} label={r.label} active={range === r.key} onPress={() => setRange(r.key)} />
        ))}
      </ScrollView>

      {range === "custom" ? (
        <View style={styles.custom}>
          <View style={styles.half}>
            <Field label={t("app.dateRange.from")} value={fromText} onChangeText={setFromText} placeholder={t("mobile.returns.datePlaceholder")} keyboardType="numbers-and-punctuation" ltr />
          </View>
          <View style={styles.half}>
            <Field label={t("app.dateRange.to")} value={toText} onChangeText={setToText} placeholder={t("mobile.returns.datePlaceholder")} keyboardType="numbers-and-punctuation" ltr />
          </View>
        </View>
      ) : null}
      {bounds.invalid ? <Text style={styles.err}>{t("mobile.returns.invalidRange")}</Text> : null}

      <Field label={t("app.common.search")} value={search} onChangeText={setSearch} placeholder={t("mobile.returns.searchPlaceholder")} autoCapitalize="none" autoCorrect={false} />

      {sales.isError && !q.isLoading && !q.isError ? (
        <View style={styles.errorBox}>
          <Text style={styles.meta}>{t("mobile.returns.salesLoadFailed")}</Text>
          <Button label={t("app.common.retry")} variant="ghost" onPress={() => void sales.refetch()} />
        </View>
      ) : null}

      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : q.isError ? (
        <View style={styles.errorBox}>
          <Text style={styles.err}>{t("mobile.returns.loadFailed")}</Text>
          <Button label={t("app.common.retry")} variant="ghost" onPress={refresh} />
        </View>
      ) : all.length === 0 ? (
        <EmptyState title={t("mobile.returns.empty")} hint={t("mobile.returns.emptyHint")} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("mobile.returns.noMatch")} />
      ) : (
        <View style={styles.list}>
          {rows.map((r) => {
            const sale = saleById.get(r.saleId);
            const amount = amountOf(r);
            return (
              <View key={r.id} style={styles.row}>
                <View style={styles.head}>
                  <Text numberOfLines={1} style={styles.name}>{r.productName}</Text>
                  {amount !== null ? <Text style={styles.amount}>{money(amount)}</Text> : null}
                </View>
                <MetaLine invoice={sale?.invoiceId} count={r.returnedQuantity} date={r.returnDate} />
                {r.reason ? <Text numberOfLines={2} style={[styles.meta, styles.reason]}>{r.reason}</Text> : null}
              </View>
            );
          })}
        </View>
      )}

      <Modal visible={open} animationType="slide" onRequestClose={closeModal}>
        <View style={[styles.modal, directionStyle(isRTL())]}>
          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>{t("app.sales.returnModal.title")}</Text>
            {!line ? (
              <>
                {error ? <Text style={styles.err}>{error}</Text> : null}
                <Text style={styles.meta}>{t("mobile.returns.pickLine")}</Text>
                <Field label={t("app.common.search")} value={pick} onChangeText={setPick} placeholder={t("mobile.returns.searchPlaceholder")} autoCapitalize="none" autoCorrect={false} />
                {sales.isLoading ? (
                  <ActivityIndicator color={colors.accent} />
                ) : sales.isError ? (
                  <View style={styles.errorBox}>
                    <Text style={styles.err}>{t("mobile.returns.salesLoadFailed")}</Text>
                    <Button label={t("app.common.retry")} variant="ghost" onPress={() => void sales.refetch()} />
                  </View>
                ) : pickable.length === 0 ? (
                  <Text style={styles.meta}>{t("mobile.returns.noLines")}</Text>
                ) : (
                  pickable.map((l) => (
                    <Pressable key={l.id} style={styles.pick} onPress={() => { setLine(l); setQty("1"); setError(null); }}>
                      <Text numberOfLines={1} style={styles.pickName}>{l.productName}</Text>
                      <MetaLine invoice={l.invoiceId} count={l.quantitySold} date={l.saleDate} />
                    </Pressable>
                  ))
                )}
              </>
            ) : (
              <>
                <Pressable style={styles.linkHit} onPress={() => { setLine(null); setError(null); }}>
                  <Text style={styles.link}>{t("mobile.returns.changeLine")}</Text>
                </Pressable>
                <Text style={styles.pickName}>{line.productName}</Text>
                <MetaLine invoice={line.invoiceId} count={line.quantitySold} date={line.saleDate} />
                <Text style={styles.meta}>{t("mobile.returns.maxQty", { n: maxQty })}</Text>
                <Field label={t("app.sales.returnModal.quantity")} value={qty} onChangeText={setQty} keyboardType="number-pad" editable={maxQty > 0} />
                <Field label={t("mobile.common.reason")} value={reason} onChangeText={setReason} placeholder={t("mobile.returns.reasonExample")} editable={maxQty > 0} />
                {error ? <Text style={styles.err}>{error}</Text> : null}
                <Button label={t("mobile.returns.submit")} disabled={!canSubmit} loading={create.isPending} onPress={() => create.mutate()} />
              </>
            )}
            <Button label={t("app.common.cancel")} variant="ghost" onPress={closeModal} />
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", gap: spacing.sm, paddingVertical: spacing.xs },
  custom: { flexDirection: "row", gap: spacing.md },
  half: { flex: 1 },
  list: { gap: spacing.md },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: 4,
    ...elevation.card,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  name: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  amount: { fontFamily: fonts.bold, fontSize: 15, color: colors.danger, fontVariant: ["tabular-nums"] },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  // Wraps rather than clips when the invoice id is long on a narrow phone.
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: spacing.xs },
  metaInvoice: { flexShrink: 1 },
  // A Latin reason ("Test") is an LTR paragraph — left-aligned when the Text
  // is stretched to the card's width. Hugging the content parks the box at
  // the start edge, which under Arabic is the right, like the name above it.
  reason: { alignSelf: "flex-start" },
  errorBox: { alignItems: "center", gap: spacing.sm },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalContent: { padding: spacing.xl, paddingTop: 60, gap: spacing.md },
  modalTitle: { fontFamily: fonts.bold, fontSize: 24, color: colors.text, ...RTL_TEXT },
  pick: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, gap: 2 },
  pickName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  link: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent, ...RTL_TEXT },
  linkHit: { minHeight: MIN_TOUCH, justifyContent: "center" },
  err: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, textAlign: "center" },
});
