import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from "phosphor-react-native/src/icons/ClockCounterClockwise";
import { CloudSlashIcon as CloudSlash } from "phosphor-react-native/src/icons/CloudSlash";
import { MinusIcon as Minus } from "phosphor-react-native/src/icons/Minus";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";
import { ApiError, catalog, sales as salesApi } from "@matgary/api-client";
import { calcLineDiscount } from "@matgary/domain";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { SearchField } from "@/components/ui/SearchField";
import { ScannerSheet, type ScanTone } from "@/components/scanner/ScannerSheet";
import { ReceiptActions } from "@/components/receipt/ReceiptActions";
import { money } from "@/lib/format";
import { clearMark, mark, measure } from "@/observability/perf";
import { useOffline, useOutbox } from "@/offline";
import { applyLocalDelta } from "@/offline/local-delta-cache";
import { enqueueSale, ensureSaleHandler, isQueueableFailure, type SaleOutboxItem } from "@/offline/sales";
import type { ReceiptSale } from "@/receipt/html";
import { toReceiptSale } from "@/receipt/share";
import { selectItemCount, selectTotals, useCart } from "@/stores/cart";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

type Payment = salesApi.PaymentMethod;

/**
 * The card shown after تسجيل الفاتورة. `rowId` is set when the sale went to
 * the outbox instead of the server; the card then follows that row (§6.4:
 * never say "synced" until the engine marks it done).
 */
interface LastSale {
  result: salesApi.CartSaleResult;
  receipt: ReceiptSale;
  rowId: string | null;
  queuedReason: "offline" | "network" | null;
  /** Local wall-clock of the ring — what options.customDate books it under. */
  rungAt: Date;
}

/** Cart-line trash glyph; sized here so trashBtn can centre it on the card edge. */
const TRASH_ICON = 18;

/**
 * The four methods the cart route accepts. Labels come from ONE namespace —
 * app.activityLabels.paymentMethods — the same one the dashboard badge,
 * sales history and the invoice detail read, so a sale is never "كاش" on the
 * POS and "نقدي" on the home screen a minute later.
 */
const PAYMENTS = (): { key: Payment; label: string }[] =>
  (["cash", "instapay", "card", "deferred"] as const).map((key) => ({
    key,
    label: t(`app.activityLabels.paymentMethods.${key}`),
  }));

/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

/**
 * The POS — app__sales-pos.png, recomposed per doc 04: the sale comes first,
 * because a cashier opens this screen to take money.
 *
 *   search / recent → tap to add → cart with ± → payment → تسجيل الفاتورة
 *
 * Totals are computed by @matgary/domain's computeCartTotals, the same
 * function the web's SaleForm uses and the server mirrors. The invoice id is
 * minted client-side and doubles as the Idempotency-Key, so a retry after a
 * dropped connection returns the original sale rather than booking a second.
 *
 * Scanning has two entry points that share one resolver (`resolveCode`): the
 * camera ScannerSheet, and a keyboard-wedge scanner typing code+Enter into the
 * search field. Both go to GET /api/v1/products?barcode= rather than the
 * in-memory list, because the server owns the UPC-A/EAN-13 collapsing rule
 * and the branch scope (route.ts comments). The sheet stays open between
 * scans; the toast strip inside it is the cashier's only confirmation, so it
 * names the product.
 */
export default function SalesScreen() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [payment, setPayment] = useState<Payment>("cash");
  // The server result (what was booked) plus the receipt built from the cart
  // as it was rung up — gross prices, per-line discounts and brands do not
  // survive `cart.reset()`, and the result alone carries only net line totals.
  const [lastSale, setLastSale] = useState<LastSale | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  // The cart route runs requirePermissionWithBranch("record_sales"); the web
  // hides the form for a user without it, so do the same here rather than
  // letting them build a cart and learn on submit via a 403. `me` unknown
  // (mid-refresh) → do not block; the server is still the authority.
  const permissions = useSession((s) => s.me?.permissions);
  const canRecord = permissions == null || permissions.includes("record_sales");

  // The outbox handler must exist before a drain looks at a queued sale.
  useEffect(() => {
    ensureSaleHandler();
  }, []);
  // A queued sale's card follows its outbox row: pending → synced / failed.
  const outbox = useOutbox<unknown, salesApi.CartSaleResult>();
  const queuedRow = useMemo(
    () => (lastSale?.rowId ? (outbox.find((r) => r.id === lastSale.rowId) as SaleOutboxItem | undefined) ?? null : null),
    [outbox, lastSale?.rowId],
  );

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scan, setScan] = useState<{ text: string; tone: ScanTone } | null>(null);
  // Guards a slow lookup answering after a faster later one.
  const scanSeq = useRef(0);

  const cart = useCart();
  // NOT a zustand selector: selectTotals returns a fresh object every call, and
  // zustand compares selector results with Object.is, so subscribing to it
  // re-renders on every render — "Maximum update depth exceeded" the first time
  // the screen opened. useMemo over the actual inputs is the correct shape.
  const totals = useMemo(
    () => selectTotals(cart),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cart.lines, cart.orderDiscountType, cart.orderDiscountValue],
  );
  const itemCount = useCart(selectItemCount);

  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(api),
  });
  const recentSales = useQuery({
    queryKey: ["sales"],
    queryFn: () => catalog.listSales(api),
  });

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (products.data ?? [])
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q) ||
          (p.barcode ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [products.data, query]);

  // "منتجات حديثة" — the last distinct products actually sold, which is what a
  // cashier reaches for most often.
  const recent = useMemo(() => {
    const byId = new Map((products.data ?? []).map((p) => [p.id, p]));
    const seen = new Set<string>();
    const out = [];
    for (const l of recentSales.data ?? []) {
      if (seen.has(l.productId)) continue;
      const p = byId.get(l.productId);
      if (!p) continue;
      seen.add(l.productId);
      out.push(p);
      if (out.length >= 5) break;
    }
    return out;
  }, [products.data, recentSales.data]);

  const checkout = useMutation({
    // TanStack pauses an "online"-mode mutation while onlineManager says
    // offline (app/_layout.tsx feeds it NetInfo) — the spinner would sit
    // there until the radio came back, which is the one thing an offline
    // POS must never do. This mutation handles offline itself (it enqueues),
    // so it must always run.
    networkMode: "always",
    mutationFn: async (): Promise<LastSale> => {
      // Snapshot before the request: the cart may be edited while it is in
      // flight and is reset on success, and the receipt must show what was
      // actually sent.
      const byId = new Map((products.data ?? []).map((p) => [p.id, p]));
      const rungAt = new Date();
      const snapshot = {
        lines: cart.lines.map((l) => ({ ...l, brand: byId.get(l.productId)?.brand ?? null })),
        orderDiscountType: cart.orderDiscountType,
        orderDiscountValue: cart.orderDiscountValue,
      };
      // One body for both paths (live POST and outbox) — byte-identical, so
      // a replay under the same Idempotency-Key is a replay, not a new sale.
      const body = salesApi.buildCartSaleBody(
        snapshot.lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          pricePerUnit: l.pricePerUnit,
          ...(l.lineDiscountValue > 0
            ? { lineDiscountType: l.lineDiscountType, lineDiscountValue: l.lineDiscountValue }
            : {}),
        })),
        {
          paymentMethod: payment,
          invoiceId: cart.invoiceId,
          // Book it under the moment it was rung, not the moment it drains:
          // a sale rung offline at 22:00 and synced at 09:00 belongs to
          // yesterday's reports, digest and shift — the day on the receipt.
          customDate: rungAt.toISOString(),
          ...(cart.customerName.trim() ? { customerName: cart.customerName.trim() } : {}),
          ...(cart.customerPhone.trim() ? { customerPhone: cart.customerPhone.trim() } : {}),
          ...(cart.note.trim() ? { note: cart.note.trim() } : {}),
          ...(cart.orderDiscountValue > 0
            ? { orderDiscountType: cart.orderDiscountType, orderDiscountValue: cart.orderDiscountValue }
            : {}),
        },
      );
      // What the receipt shows while the server has not answered: the same
      // totals the server will book (computeCartTotals mirrors the route).
      const localResult: salesApi.CartSaleResult = {
        invoiceId: cart.invoiceId,
        saleIds: [],
        lines: snapshot.lines.map((l) => ({
          productId: l.productId,
          productName: l.name,
          quantity: l.quantity,
          lineTotal: l.quantity * l.pricePerUnit - calcLineDiscount(l.quantity, l.pricePerUnit, l.lineDiscountType, l.lineDiscountValue),
        })),
        total: totals.afterOrderDiscount,
        paymentMethod: payment,
        customerName: body.options.customerName ?? null,
        customerPhone: body.options.customerPhone ?? null,
        note: body.options.note ?? null,
      };
      // Product names ride along in the outbox row (client-only sidecar) so the
      // sync screen can list the lines and Edit can rebuild the cart offline.
      const names = Object.fromEntries(snapshot.lines.map((l) => [l.productId, l.name]));
      // So does the catalogue's `updatedAt` per product, as the POS saw it at
      // ring time (the wire sends it; the api-client Product type does not
      // declare it yet). localDelta keeps this sale's decrement only while the
      // server still reports the same stamp (§6.5 server wins) — two server
      // strings compared, never the device clock against the server's.
      const catalogUpdatedAt: Record<string, string> = Object.fromEntries(
        snapshot.lines.flatMap((l) => {
          const product: unknown = byId.get(l.productId);
          const at = typeof product === "object" && product !== null ? (product as { updatedAt?: unknown }).updatedAt : undefined;
          return typeof at === "string" && at ? [[l.productId, at] as const] : [];
        }),
      );
      const queued = (reason: "offline" | "network"): LastSale => ({
        result: localResult,
        receipt: toReceiptSale(snapshot, localResult),
        rowId: enqueueSale(body, cart.invoiceId, names, catalogUpdatedAt),
        queuedReason: reason,
        rungAt,
      });

      // Known offline: do not even try — queue, and the cashier keeps selling.
      if (!useOffline.getState().online) return queued("offline");

      try {
        const result = await salesApi.sendCartSale(api, body, cart.invoiceId);
        return { result, receipt: toReceiptSale(snapshot, result), rowId: null, queuedReason: null, rungAt };
      } catch (e) {
        // Never reached the server / server failed: the outbox owns it from
        // here under the SAME key, so a half-sent sale cannot double-post.
        // Auth walls and terminal 4xx are shown, never queued.
        if (isQueueableFailure(e)) return queued("network");
        throw e;
      }
    },
    onSuccess: (sale) => {
      setLastSale(sale);
      setError(null);
      cart.reset();
      setQuery("");
      // Queued (not booked): subtract the rung units from the cached catalogue
      // NOW (localDelta, §6.5) so the next chip tap — and the cart's stock cap —
      // sees what is really left on the shelf. The server's answer replaces
      // it once the row lands.
      if (sale.rowId) applyLocalDelta(qc);
      // Stock moved and the dashboard's numbers are stale — everything that
      // reads either must refetch. (A queued sale invalidates too: cheap, and
      // it means the caches are fresh the moment the drain lands it.)
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["sales"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      void qc.invalidateQueries({ queryKey: ["insights-overview"] });
    },
    onError: (e) => {
      clearMark("pos.checkout-tap");
      setError(messageFor(e));
    },
  });

  // §10.3 "checkout tap → receipt screen" (≤ 150 ms offline, ≤ 800 ms online):
  // closed here, after the commit that put the receipt card on screen, not in
  // onSuccess (which runs before React has rendered it). `queued` tells the
  // two budgets apart: a queued sale never left the device.
  useEffect(() => {
    if (!lastSale) return;
    measure("pos.checkout-receipt", "pos.checkout-tap", {
      consume: true,
      attributes: { queued: lastSale.rowId != null },
    });
  }, [lastSale]);

  // The queued row landed: prefer the server's own lines / total on the card.
  const shownResult = queuedRow?.status === "done" && queuedRow.response ? queuedRow.response : lastSale?.result ?? null;
  // "removed": the row was queued but is no longer in the outbox — the cashier
  // discarded or edited it on /sync (tabs stay mounted), or the tenant scope
  // changed. Never show that as "pending": nothing is going to sync it.
  const rowGone = lastSale?.rowId != null && !queuedRow;
  const syncState: "synced" | "pending" | "failed" | "removed" | null = !lastSale
    ? null
    : lastSale.rowId == null || queuedRow?.status === "done"
      ? "synced"
      : rowGone
        ? "removed"
        : queuedRow?.status === "failed"
          ? "failed"
          : "pending";

  const canCheckout = canRecord && cart.lines.length > 0 && !checkout.isPending;

  const resolveCode = useCallback(
    async (raw: string) => {
      const code = raw.trim();
      if (!code) return;
      const seq = ++scanSeq.current;
      setScan({ text: t("app.ui.scanner.detected", { code }), tone: "info" });
      let result: catalog.BarcodeLookup;
      try {
        result = await catalog.findProductByBarcode(api, code);
      } catch (e) {
        // Staleness first: in continuous mode a failed lookup for scan A must
        // not wipe the start mark scan B has already stamped.
        if (seq !== scanSeq.current) return;
        clearMark("pos.scan-decoded");
        setScan({ text: messageFor(e), tone: "error" });
        return;
      }
      if (seq !== scanSeq.current) return;
      const p = result.product;
      if (!p) {
        clearMark("pos.scan-decoded");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        setScan({ text: t("app.sales.form.productSearch.scannedNotFound", { code }), tone: "error" });
        return;
      }
      if (p.quantity <= 0) {
        clearMark("pos.scan-decoded");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        setScan({ text: `${p.name} — ${t("app.sales.form.productSearch.scannedOutOfStock")}`, tone: "error" });
        return;
      }
      // Read the store directly: this callback outlives the render it was
      // created in, and the sheet fires it once per item.
      const store = useCart.getState();
      const already = store.lines.some((l) => l.productId === p.id);
      store.add(p);
      // §10.3 "scan → line added to cart" (≤ 150 ms). The start is stamped by
      // ScannerSheet on a CAMERA decode only; a typed code (the sheet's manual
      // field or the search box) has none, so this is a no-op for that path.
      // Consumed: one line per scan.
      measure("pos.scan-to-cart", "pos.scan-decoded", { consume: true });
      setScan({
        text: already
          ? t("app.sales.form.productSearch.scannedIncremented", { name: p.name })
          : t("app.sales.form.productSearch.scannedAdded", { name: p.name }),
        tone: "success",
      });
    },
    [],
  );

  return (
    <Screen
      title={t("app.shell.primary.sales")}
      onRefresh={() => void products.refetch()}
      refreshing={products.isRefetching}
    >
      {/* Doc 02 §1.1 row 2: the ledger is its own screen (sales/history). */}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/sales/history")}
        style={({ pressed }) => [styles.historyRow, pressed && styles.historyRowPressed]}
        testID="pos-open-history"
      >
        <View style={styles.historyIcon}>
          <ClockCounterClockwise size={20} color={colors.accent} />
        </View>
        <View style={styles.historyText}>
          <Text style={styles.historyTitle}>{t("mobile.salesHistory.title")}</Text>
          <Text style={styles.historyHint} numberOfLines={1}>{t("mobile.salesHistory.entryHint")}</Text>
        </View>
        <ChevronForward size={16} color={colors.textSecondary} />
      </Pressable>

      {lastSale && shownResult ? (
        <Card>
          <View style={styles.successHead} testID="pos-sale-result">
            {syncState === "synced" ? (
              <CheckCircle size={28} color={colors.success} weight="fill" />
            ) : syncState === "failed" ? (
              <WarningCircle size={28} color={colors.danger} weight="fill" />
            ) : syncState === "removed" ? (
              <Trash size={28} color={colors.textSecondary} weight="fill" />
            ) : (
              <CloudSlash size={28} color={colors.warningStrong} weight="fill" />
            )}
            <Text
              style={[
                styles.successTitle,
                syncState === "pending" && styles.successTitlePending,
                syncState === "failed" && styles.successTitleFailed,
                syncState === "removed" && styles.successTitleRemoved,
              ]}
            >
              {syncState === "synced"
                ? t("app.sales.toast.saleSuccess")
                : syncState === "removed"
                  ? t("mobile.pos.removedBadge")
                  : t("mobile.pos.queuedTitle")}
            </Text>
          </View>
          <View style={styles.successMeta}>
            <Text style={styles.successInvoice}>{shownResult.invoiceId}</Text>
            {syncState === "pending" ? (
              <View testID="pos-sync-pending">
                <Badge label={t("mobile.pos.queuedBadge")} variant="lowstock" />
              </View>
            ) : syncState === "failed" ? (
              <View testID="pos-sync-failed">
                <Badge label={t("mobile.pos.syncFailedBadge")} variant="outofstock" />
              </View>
            ) : syncState === "removed" ? (
              <Badge label={t("mobile.pos.removedBadge")} variant="neutral" />
            ) : lastSale.rowId ? (
              <View testID="pos-sync-synced">
                <Badge label={t("mobile.pos.syncedBadge")} variant="success" />
              </View>
            ) : null}
          </View>
          {syncState === "pending" ? (
            <>
              <Text style={styles.successHint}>
                {lastSale.queuedReason === "network" ? t("mobile.pos.queuedNetworkHint") : t("mobile.pos.queuedHint")}
              </Text>
              <Text style={styles.successHint}>{t("mobile.pos.rungAt", { when: localTime(lastSale.rungAt) })}</Text>
            </>
          ) : null}
          {syncState === "removed" ? <Text style={styles.successHint}>{t("mobile.pos.removedHint")}</Text> : null}
          {syncState === "failed" ? (
            <Pressable onPress={() => router.push("/sync")} hitSlop={8}>
              <Text style={[styles.successHint, styles.successHintDanger]}>
                {t("mobile.pos.syncFailedHint")} {t("mobile.pos.openSync")}
              </Text>
            </Pressable>
          ) : null}
          <View style={styles.receipt} testID="pos-receipt">
            {shownResult.lines.map((l) => (
              <View key={l.productId} style={styles.receiptRow}>
                <Text numberOfLines={1} style={styles.receiptName}>
                  {l.productName} ×{l.quantity}
                </Text>
                <Text style={styles.receiptAmt}>{money(l.lineTotal)}</Text>
              </View>
            ))}
            <View style={[styles.receiptRow, styles.receiptTotal]}>
              <Text style={styles.receiptTotalLabel}>{t("app.sales.table.col.total")}</Text>
              <Text style={styles.receiptTotalAmt}>{money(shownResult.total)}</Text>
            </View>
          </View>
          <ReceiptActions sale={lastSale.receipt} />
          <Button label={t("app.notificationSettings.events.sale.created.title")} onPress={() => setLastSale(null)} />
        </Card>
      ) : null}

      {!canRecord ? (
        <Card>
          <View style={styles.successHead}>
            <WarningCircle size={24} color={colors.danger} weight="fill" />
            <Text style={[styles.successTitle, styles.successTitleFailed]}>{t("mobile.pos.noPermission")}</Text>
          </View>
          <Text style={styles.successHint}>{t("mobile.pos.noPermissionHint")}</Text>
        </Card>
      ) : null}

      {canRecord ? (
      <Card title={t("app.sales.form.title")}>
        <Text style={styles.label}>{t("app.sales.form.productSearch.label")}</Text>
        <SearchField
          testID="pos-search"
          value={query}
          onChangeText={(v) => {
            setQuery(v);
            if (scan) setScan(null);
          }}
          placeholder={t("app.sales.form.productSearch.placeholder")}
          onPressScan={() => {
            setScan(null);
            setScannerOpen(true);
          }}
          onSubmitEditing={(v) => {
            // Keyboard-wedge scanner: the code arrives as typed text + Enter.
            if (!v.trim()) return;
            setQuery("");
            void resolveCode(v);
          }}
        />
        {scan && !scannerOpen ? (
          <View
            style={[
              styles.scanStrip,
              scan.tone === "success" && styles.scanStripSuccess,
              scan.tone === "error" && styles.scanStripError,
            ]}
            accessibilityLiveRegion="polite"
          >
            <Text
              numberOfLines={2}
              style={[
                styles.scanStripText,
                scan.tone === "success" && styles.scanStripTextSuccess,
                scan.tone === "error" && styles.scanStripTextError,
              ]}
            >
              {scan.text}
            </Text>
          </View>
        ) : null}

        {query.trim() ? (
          matches.length ? (
            <View style={styles.results}>
              {matches.map((p) => {
                const out = p.quantity <= 0;
                return (
                  <Pressable
                    key={p.id}
                    style={[styles.result, out && styles.resultOut]}
                    disabled={out}
                    onPress={() => {
                      cart.add(p);
                      setQuery("");
                    }}
                    accessibilityRole="button"
                  >
                    <View style={styles.resultText}>
                      <Text numberOfLines={1} style={styles.resultName}>
                        {p.name}
                      </Text>
                      <Text style={styles.resultStock}>
                        {out ? t("mobile.common.notAvailable") : t("mobile.pos.available", { n: p.quantity })}
                      </Text>
                    </View>
                    <Text style={styles.resultPrice}>{money(p.price)}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <Text style={styles.muted}>{t("app.sales.form.productSearch.noMatch")}</Text>
          )
        ) : recent.length ? (
          <>
            <Text style={[styles.label, styles.recentLabel]}>{t("app.sales.form.recentLabel")}</Text>
            <View style={styles.pillRow}>
              {recent.map((p) => (
                <Pressable
                  key={p.id}
                  style={styles.pill}
                  testID="pos-recent-chip"
                  onPress={() => cart.add(p)}
                  accessibilityRole="button"
                  accessibilityLabel={p.name}
                >
                  <Text numberOfLines={1} style={styles.pillText}>
                    {p.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </Card>
      ) : null}

      {canRecord && cart.lines.length === 0 && !lastSale ? (
        <EmptyState title={t("mobile.pos.cartEmpty")} hint={t("mobile.pos.emptyCartHint")} />
      ) : null}

      {canRecord && cart.lines.length > 0 ? (
        <Card title={t(`mobile.pos.itemsInCart${countForm(itemCount)}`, { n: itemCount })}>
          <View style={styles.cartList}>
            {cart.lines.map((l) => (
              <View key={l.productId} style={styles.cartRow}>
                {/* Two rows per line: the name gets the full width (a cashier
                    must be able to read "Casio Edifice EFR-…" in full), the
                    stepper and the line total share the row beneath. */}
                <View style={styles.cartHead}>
                  <View style={styles.cartText}>
                    <Text numberOfLines={2} style={styles.cartName}>
                      {l.name}
                    </Text>
                    <Text style={styles.cartUnit}>
                      {money(l.pricePerUnit)} × {l.quantity}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => cart.remove(l.productId)}
                    style={styles.trashBtn}
                    accessibilityRole="button"
                    accessibilityLabel={t("app.sales.void.confirm")}
                  >
                    <Trash size={TRASH_ICON} color={colors.textSecondary} />
                  </Pressable>
                </View>
                <View style={styles.cartControls}>
                  <View style={styles.qty}>
                    <Pressable
                      style={styles.qtyBtn}
                      hitSlop={4}
                      onPress={() => cart.setQuantity(l.productId, l.quantity - 1)}
                      accessibilityRole="button"
                      accessibilityLabel={t("mobile.common.decrease")}
                    >
                      <Minus size={16} color={colors.accent} weight="bold" />
                    </Pressable>
                    <Text style={styles.qtyValue}>{l.quantity}</Text>
                    <Pressable
                      style={[styles.qtyBtn, l.quantity >= l.available && styles.qtyBtnDisabled]}
                      hitSlop={4}
                      disabled={l.quantity >= l.available}
                      onPress={() => cart.setQuantity(l.productId, l.quantity + 1)}
                      accessibilityRole="button"
                      accessibilityLabel={t("mobile.common.increase")}
                    >
                      <Plus size={16} color={colors.accent} weight="bold" />
                    </Pressable>
                  </View>
                  <Text style={styles.cartTotal}>{money(l.quantity * l.pricePerUnit)}</Text>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.totals} testID="pos-cart-totals">
            <TotalRow label={t("app.sales.form.totals.subtotal")} value={money(totals.subtotalGross)} />
            {totals.lineDiscountTotal > 0 ? (
              <TotalRow label={t("app.sales.form.totals.lineDiscounts")} value={`- ${money(totals.lineDiscountTotal)}`} />
            ) : null}
            {totals.orderDiscount > 0 ? (
              <TotalRow label={t("app.sales.form.totals.orderDiscount")} value={`- ${money(totals.orderDiscount)}`} />
            ) : null}
            <TotalRow label={t("app.sales.table.col.total")} value={money(totals.afterOrderDiscount)} strong />
          </View>

          <Text style={styles.label}>{t("app.sales.form.payment.label")}</Text>
          <View style={styles.pillRow}>
            {PAYMENTS().map((p) => (
              <Chip
                key={p.key}
                label={p.label}
                active={payment === p.key}
                onPress={() => setPayment(p.key)}
              />
            ))}
          </View>
          {payment === "deferred" ? (
            <Text style={styles.muted}>
              {t("app.sales.form.payment.deferredNote")}
            </Text>
          ) : null}

          <View style={styles.customer}>
            <Field
              label={t("app.sales.form.customer.nameLabel")}
              value={cart.customerName}
              onChangeText={(v) => cart.setCustomer(v, cart.customerPhone)}
            />
            <Field
              label={t("app.sales.form.customer.phoneLabel")}
              value={cart.customerPhone}
              onChangeText={(v) => cart.setCustomer(cart.customerName, v)}
              keyboardType="phone-pad"
              placeholder={t("app.sales.form.customer.phonePlaceholder")}
            />
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Button
            label={t("app.sales.form.submit")}
            loading={checkout.isPending}
            disabled={!canCheckout}
            onPress={() => {
              mark("pos.checkout-tap");
              checkout.mutate();
            }}
          />
        </Card>
      ) : null}

      {products.isLoading ? <ActivityIndicator color={colors.accent} /> : null}

      <ScannerSheet
        visible={scannerOpen}
        mode="continuous"
        onClose={() => setScannerOpen(false)}
        onScan={(code) => void resolveCode(code)}
        message={scan?.text ?? null}
        tone={scan?.tone ?? "info"}
      />
    </Screen>
  );
}

/** Local HH:MM of a Date — no Intl on device (see lib/format). */
function localTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, strong && styles.totalStrong]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.totalValue, strong && styles.totalStrong]}>
        {value}
      </Text>
    </View>
  );
}

/**
 * The cart route answers three ways: a machine code (INSUFFICIENT_STOCK), a
 * raw English zod message on 400, or Arabic prose. Only the first is safe to
 * map; the rest fall to a generic line rather than showing an Arabic-speaking
 * shopkeeper "Expected number, received string".
 */
function messageFor(e: unknown): string {
  if (!(e instanceof ApiError)) return t("mobile.pos.saveFailed");
  switch (e.code) {
    case "INSUFFICIENT_STOCK":
      return t("mobile.pos.insufficientStock");
    case "PRODUCT_NOT_FOUND":
      return t("mobile.pos.productGone");
    case "PRODUCT_WRONG_BRANCH":
      return t("mobile.pos.wrongBranch");
    case "CART_EMPTY":
      return t("mobile.pos.cartEmpty");
  }
  switch (e.kind) {
    case "offline":
      return t("mobile.pos.offlineNotSaved");
    case "timeout":
      return t("mobile.pos.timeoutNotSaved");
    case "rateLimited":
      return t("mobile.common.tooManyAttempts");
    case "forbidden":
      return t("mobile.pos.noPermission");
    default:
      return t("mobile.pos.saveFailed");
  }
}

const styles = StyleSheet.create({
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  historyRowPressed: { backgroundColor: colors.accentLight },
  historyIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  historyText: { flex: 1, gap: 1 },
  historyTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  historyHint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  // fonts.medium matches Field's own label, so the free-standing labels on
  // this card do not read lighter than the ones the inputs draw themselves.
  label: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, marginBottom: spacing.sm, ...RTL_TEXT },
  recentLabel: { marginTop: spacing.lg },
  muted: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginTop: spacing.sm, ...RTL_TEXT },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.sm },
  // Recent-product chips. flexShrink 0 + numberOfLines 1 is the Chip lesson
  // (a shrinking child breaks its text at every space); maxWidth 48% is what
  // keeps this a chip ROW — five 44pt pills with real product names ("Chanel
  // Coco Mademoiselle 50ml") each measured wider than half the card, so Yoga
  // wrapped every one onto its own line and the row read as a vertical list.
  // The cap ellipsises a long name instead; the full name shows in the cart.
  // Same height, corner radius and type size as the payment <Chip>s that share
  // this card, so the two pill rows read as one system; accent tint (not the
  // Chip's bordered outline) keeps "tap to add" distinct from "select one".
  pill: { backgroundColor: colors.accentLight, borderRadius: radius.md, paddingHorizontal: spacing.md, minHeight: MIN_TOUCH, justifyContent: "center", flexShrink: 0, maxWidth: "100%" },
  pillText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.accent },
  results: { marginTop: spacing.md, gap: spacing.sm },
  result: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, minHeight: 56, paddingHorizontal: spacing.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  resultOut: { opacity: 0.45 },
  resultText: { flexShrink: 1, minWidth: 0 },
  resultName: { fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  resultStock: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  resultPrice: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"], flexShrink: 0 },
  cartList: { gap: spacing.sm },
  cartRow: { gap: spacing.xs, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  cartHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  cartControls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  cartText: { flex: 1, minWidth: 0 },
  // Negative end margin pulls the 44pt hit box out so the 18pt glyph's outer
  // edge lands on the edge the line total and totals column share (Field.tsx
  // does the same for its eye slot).
  trashBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center", marginTop: -spacing.sm, marginEnd: -((MIN_TOUCH - TRASH_ICON) / 2) },
  cartName: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  cartUnit: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  qty: { flexDirection: "row", alignItems: "center", gap: 4 },
  qtyBtn: { width: 40, height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: colors.accent, alignItems: "center", justifyContent: "center" },
  qtyBtnDisabled: { opacity: 0.35 },
  qtyValue: { minWidth: 28, textAlign: "center", fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  // End-aligned (textAlign "right" = END under the Fabric swap) so a column of
  // line totals rags against the same edge whatever their digit count.
  cartTotal: { fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"], flexShrink: 0, textAlign: "right" },
  totals: { marginTop: spacing.lg, marginBottom: spacing.lg, gap: 6 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md },
  totalLabel: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  totalValue: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] },
  totalStrong: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 18, color: colors.text },
  customer: { gap: spacing.md, marginTop: spacing.sm, marginBottom: spacing.lg },
  errorBox: { backgroundColor: colors.dangerLight, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  scanStrip: { marginTop: spacing.sm, minHeight: 44, justifyContent: "center", borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: colors.neutralTint },
  scanStripSuccess: { backgroundColor: colors.successLight },
  scanStripError: { backgroundColor: colors.dangerLight },
  // Centred on purpose (no RTL_TEXT): the feedback strip is a banner, not a
  // start-aligned label — and RTL_TEXT after textAlign would win and pin it left.
  scanStripText: { fontFamily: fonts.medium, fontSize: 14, color: colors.neutralText, textAlign: "center" },
  scanStripTextSuccess: { color: colors.successStrong },
  scanStripTextError: { color: colors.danger },
  errorText: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, textAlign: "center" },
  successHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: 4 },
  successTitle: { fontFamily: fonts.bold, fontSize: 18, color: colors.successStrong, ...RTL_TEXT },
  successTitlePending: { color: colors.warningStrong },
  successTitleFailed: { color: colors.danger },
  successTitleRemoved: { color: colors.textSecondary },
  successInvoice: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  successMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, flexWrap: "wrap", marginBottom: spacing.md },
  successHint: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginTop: -spacing.xs, ...RTL_TEXT },
  successHintDanger: { color: colors.danger },
  receipt: { gap: 6, marginBottom: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  receiptRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md },
  receiptName: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.text, ...RTL_TEXT },
  receiptAmt: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] },
  receiptTotal: { marginTop: 4, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  receiptTotalLabel: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  receiptTotalAmt: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 18, color: colors.text, fontVariant: ["tabular-nums"] },
});
