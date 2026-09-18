import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "phosphor-react-native/src/icons/ArrowCounterClockwise";
import { CloudSlashIcon as CloudSlash } from "phosphor-react-native/src/icons/CloudSlash";
import { PauseCircleIcon as PauseCircle } from "phosphor-react-native/src/icons/PauseCircle";
import { PencilSimpleIcon as PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";
import { ShoppingCartSimpleIcon as ShoppingCartSimple } from "phosphor-react-native/src/icons/ShoppingCartSimple";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";

import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { money, shortDate } from "@/lib/format";
import { drainNow, retry, retryAllFailed, useOffline, useOutbox, type DrainResult, type OutboxItem } from "@/offline";
import { isBranchMismatchRow } from "@/offline/branch-mismatch";
import { useDevOffline } from "@/offline/dev-offline";
import {
  SALE_KIND,
  canSellAnyway,
  describeSalePayload,
  discardSale,
  ensureSaleHandler,
  isOversellRefusal,
  loadSaleIntoCart,
  retrySale,
  saleRetryMode,
  sellAnyway,
  type SaleOutboxItem,
  type SalePayload,
  type SaleRetryMode,
} from "@/offline/sales";
import { useCart } from "@/stores/cart";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Sync / failed-sales triage — doc 02 §1.4 (mandatory in v1) and doc 06 §6.3
 * defect 4: the web had listAll/retry/discard wired to nothing, so a failed
 * offline sale was invisible and unrecoverable. Here every non-synced row is
 * a card: what it is, which invoice, how much, when, how many tries, and why
 * the last one failed — in plain words, never a status code.
 *
 * Order: failed first (a human is needed), then waiting, then what synced in
 * the last day (so a cashier can confirm a receipt they handed out landed).
 * Retry resets the backoff; discard is behind a confirm that says, for a sale,
 * that the money and stock movement are gone for good (§6.6).
 *
 * A failed sale has a THIRD action, Edit (§2.2.4 / doc 06 §6.3 defect 4):
 * a domain refusal is answered the same way for the same body, so Retry is
 * a no-op for those codes. Edit loads the row back into the cart under a
 * fresh invoice id (the server never booked the original, so it cannot
 * double-post) and discards the row, keeping its audit copy. For those codes
 * Retry is hidden — offering a button that cannot work is worse than none.
 *
 * INSUFFICIENT_STOCK gets the §6.5 resolution sheet instead: the customer
 * already left with the goods. "Sell anyway" (S7) re-submits the SAME key
 * with `allowOversell: true` — see offline/sales.ts sellAnyway; the route
 * caches 2xx only, so the corrected retry succeeds, the product floors at 0
 * and a discrepancy row is logged. Once the row lands `done`, the local
 * delta cache invalidates ["products"] so stock re-reads from the server.
 * The action is gated by SELL_ANYWAY_ENABLED (canSellAnyway). PRODUCT_NOT_FOUND
 * offers Edit (re-map the line) and Discard, with a hint saying why.
 *
 * DEV BUILDS ONLY: a "Simulate offline" switch at the bottom (offline/
 * dev-offline.ts) — the e2e offline-sale.yaml drives it. Guarded by __DEV__
 * so release bundles carry neither the card nor the code behind it.
 */
export default function SyncScreen() {
  const off = useOffline();
  const rows = useOutbox();
  const branches = useSession((s) => s.me?.branches ?? []);
  const myUserId = useSession((s) => s.me?.user.id ?? null);
  const router = useRouter();
  // Same key as the POS: a shared cache. Names for lines rung before the
  // sidecar existed, and current stock for Edit's ± caps. Not required —
  // offline, the sidecar names and the rung quantities stand in.
  const products = useQuery({ queryKey: ["products"], queryFn: () => catalog.listProducts(api) });
  const productName = useCallback(
    (id: string) => products.data?.find((p) => p.id === id)?.name ?? null,
    [products.data],
  );
  const [lastResult, setLastResult] = useState<DrainResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Re-render every 30s so "5 minutes ago" and "next try in 2 min" stay true.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    ensureSaleHandler();
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const failed = useMemo(() => rows.filter((r) => r.status === "failed"), [rows]);
  const pending = useMemo(() => rows.filter((r) => r.status === "queued" || r.status === "sending"), [rows]);
  const done = useMemo(() => rows.filter((r) => r.status === "done").slice(0, 10), [rows]);

  const sync = useCallback(async () => {
    setNow(Date.now());
    const r = await drainNow("manual");
    setLastResult(r);
    setNow(Date.now());
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await sync();
    } finally {
      setRefreshing(false);
    }
  }, [sync]);

  const onRetry = useCallback(async (item: OutboxItem) => {
    setBusyId(item.id);
    try {
      // A sale whose failure is the route's own cached 500 is re-keyed
      // (retrySale); everything else replays the original key.
      setLastResult(item.kind === SALE_KIND ? await retrySale(item as SaleOutboxItem) : await retry(item.id));
    } finally {
      setBusyId(null);
    }
  }, []);

  const onEdit = useCallback(
    (item: OutboxItem) => {
      if (item.status === "sending") {
        Alert.alert(t("mobile.sync.edit"), t("mobile.sync.discardBusy"));
        return;
      }
      const sale = item as SaleOutboxItem;
      const { invoiceId } = describeSalePayload(sale.payload);
      const inCart = useCart.getState().lines.reduce((n, l) => n + l.quantity, 0);
      const body = [
        t("mobile.sync.editSaleBody", { id: invoiceId ?? item.idempotencyKey }),
        inCart > 0 ? t("mobile.sync.editReplacesCart", { n: inCart }) : null,
      ]
        .filter(Boolean)
        .join("\n\n");
      Alert.alert(t("mobile.sync.editTitle"), body, [
        { text: t("app.common.cancel"), style: "cancel" },
        {
          text: t("mobile.sync.editConfirm"),
          onPress: () => {
            const fresh = loadSaleIntoCart(sale, products.data, t("mobile.sync.unknownProduct"));
            if (!fresh) {
              Alert.alert(t("mobile.sync.edit"), t("mobile.sync.discardBusy"));
              return;
            }
            router.push("/sales");
          },
        },
      ]);
    },
    [products.data, router],
  );

  const onSellAnyway = useCallback((item: OutboxItem) => {
    if (item.status === "sending") {
      Alert.alert(t("mobile.sync.sellAnyway"), t("mobile.sync.discardBusy"));
      return;
    }
    const sale = item as SaleOutboxItem;
    const { invoiceId } = describeSalePayload(sale.payload);
    Alert.alert(t("mobile.sync.sellAnywayTitle"), t("mobile.sync.sellAnywayBody", { id: invoiceId ?? item.idempotencyKey }), [
      { text: t("app.common.cancel"), style: "cancel" },
      {
        text: t("mobile.sync.sellAnywayConfirm"),
        onPress: () => {
          setBusyId(item.id);
          const p = sellAnyway(sale);
          if (typeof p === "string") {
            setBusyId(null);
            Alert.alert(t("mobile.sync.sellAnyway"), t(p === "signed-out" ? "mobile.sync.signedOut" : "mobile.sync.discardBusy"));
            return;
          }
          void p.then(setLastResult).finally(() => setBusyId(null));
        },
      },
    ]);
  }, []);

  const onRetryAll = useCallback(async () => {
    setLastResult(await retryAllFailed());
  }, []);

  const onDiscard = useCallback((item: OutboxItem) => {
    if (item.status === "sending") {
      Alert.alert(t("mobile.sync.discard"), t("mobile.sync.discardBusy"));
      return;
    }
    const isSale = item.kind === SALE_KIND;
    const { invoiceId } = describeSalePayload(isSale ? (item.payload as SalePayload) : null);
    const doDiscard = (reason: string | null) => {
      if (!discardSale(item.id, reason)) Alert.alert(t("mobile.sync.discard"), t("mobile.sync.discardBusy"));
    };
    const body = isSale ? t("mobile.sync.discardSaleBody", { id: invoiceId ?? item.idempotencyKey }) : t("mobile.sync.discardBody");
    Alert.alert(t("mobile.sync.discardTitle"), body, [
      { text: t("app.common.cancel"), style: "cancel" },
      {
        text: t("mobile.sync.discardConfirm"),
        style: "destructive",
        onPress: () => {
          // §2.2.4 "discard with reason (writes an audit row)". Alert.prompt is
          // iOS-only; Android has no native text prompt, so the reason is
          // recorded as null there rather than blocking the discard.
          if (Platform.OS === "ios") {
            Alert.prompt(
              t("mobile.sync.discardReasonTitle"),
              t("mobile.sync.discardReasonPlaceholder"),
              [
                { text: t("app.common.cancel"), style: "cancel" },
                { text: t("mobile.sync.discardConfirm"), style: "destructive", onPress: (reason?: string) => doDiscard(reason ?? null) },
              ],
              "plain-text",
            );
          } else {
            doDiscard(null);
          }
        },
      },
    ]);
  }, []);

  const branchName = useCallback(
    (id: string | null) => (id ? branches.find((b) => b.id === id)?.name ?? null : null),
    [branches],
  );

  const nothingPending = failed.length === 0 && pending.length === 0;

  return (
    <Screen title={t("mobile.sync.title")} subtitle={t("mobile.sync.subtitle")} onRefresh={() => void onRefresh()} refreshing={refreshing}>
      <View style={styles.stats}>
        <Stat label={t("mobile.sync.stat.queued")} value={String(off.queued)} tone={off.queued > 0 ? "warning" : "neutral"} testID="sync-stat-queued" />
        <Stat label={t("mobile.sync.stat.failed")} value={String(off.failed)} tone={off.failed > 0 ? "danger" : "neutral"} />
        <Stat
          label={t("mobile.sync.stat.lastSynced")}
          value={off.lastSyncedAt ? ago(off.lastSyncedAt, now) : t("mobile.sync.never")}
          tone="neutral"
          small
        />
      </View>

      {!off.online ? (
        <View style={[styles.banner, styles.bannerWarning]}>
          <CloudSlash size={20} color={colors.warningStrong} weight="fill" />
          <Text style={[styles.bannerText, { color: colors.warningStrong }]}>{t("mobile.sync.offlineBanner")}</Text>
        </View>
      ) : null}
      {off.paused === "auth" ? (
        <View style={[styles.banner, styles.bannerDanger]}>
          <PauseCircle size={20} color={colors.danger} weight="fill" />
          <Text style={[styles.bannerText, { color: colors.danger }]}>
            {t("mobile.sync.pausedBanner", { reason: pausedReason(off.pausedCode) })}
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <View style={styles.grow} testID="sync-now">
          <Button
            label={t("mobile.sync.syncNow")}
            onPress={() => void sync()}
            loading={off.draining}
            disabled={!off.online || off.draining}
          />
        </View>
        {/* Dev-only, sits first so a QA run never has to scroll past synced items. */}
        {__DEV__ ? <DevTools /> : null}
        {failed.length > 0 ? (
          <Button label={t("mobile.sync.retryAll")} variant="outline" onPress={() => void onRetryAll()} disabled={off.draining} style={styles.grow} />
        ) : null}
      </View>
      {lastResult ? <Text style={styles.resultLine}>{drainSummary(lastResult)}</Text> : null}

      {nothingPending ? (
        <EmptyState title={t("mobile.sync.emptyTitle")} hint={t("mobile.sync.emptyHint")} />
      ) : null}

      {failed.length > 0 ? (
        <>
          <Text style={styles.section}>{t("mobile.sync.section.failed")}</Text>
          {failed.map((item) => (
            <OutboxCard
              key={item.id}
              item={item}
              now={now}
              busy={busyId === item.id || off.draining}
              branchName={branchName(item.branchId)}
              otherUser={!!myUserId && !!item.userId && item.userId !== myUserId}
              productName={productName}
              onRetry={onRetry}
              onEdit={item.kind === SALE_KIND ? onEdit : undefined}
              onSellAnyway={canSellAnyway(item) ? onSellAnyway : undefined}
              onDiscard={onDiscard}
            />
          ))}
        </>
      ) : null}

      {pending.length > 0 ? (
        <>
          <Text style={styles.section}>{t("mobile.sync.section.pending")}</Text>
          {pending.map((item) => (
            <OutboxCard
              key={item.id}
              item={item}
              now={now}
              busy={busyId === item.id || off.draining}
              branchName={branchName(item.branchId)}
              otherUser={!!myUserId && !!item.userId && item.userId !== myUserId}
              productName={productName}
              onRetry={onRetry}
              onDiscard={onDiscard}
            />
          ))}
        </>
      ) : null}

      {done.length > 0 ? (
        <>
          <Text style={styles.section}>{t("mobile.sync.section.done")}</Text>
          {done.map((item) => (
            <OutboxCard key={item.id} item={item} now={now} busy={false} branchName={branchName(item.branchId)} otherUser={false} productName={productName} />
          ))}
        </>
      ) : null}

    </Screen>
  );
}

// ─── pieces ──────────────────────────────────────────────────────────────────

/**
 * DEV-ONLY card (never rendered in release: the caller is behind __DEV__, and
 * so is every line in offline/dev-offline.ts). One switch: simulate offline.
 */
function DevTools() {
  const simulate = useDevOffline((s) => s.simulate);
  const setSimulate = useDevOffline((s) => s.setSimulate);
  return (
    <Card style={styles.devCard}>
      <Text style={styles.devTitle} testID="sync-dev-tools">{t("mobile.sync.dev.title")}</Text>
      <View style={styles.devRow}>
        <View style={styles.devBody}>
          <Text style={styles.devLabel}>{t("mobile.sync.dev.simulateOffline")}</Text>
          <Text style={styles.devHint}>{t("mobile.sync.dev.simulateOfflineHint")}</Text>
        </View>
        <Switch
          value={simulate}
          onValueChange={setSimulate}
          trackColor={{ true: colors.warningStrong, false: colors.border }}
          accessibilityLabel={t("mobile.sync.dev.simulateOffline")}
          testID="sync-simulate-offline"
        />
      </View>
    </Card>
  );
}

function Stat({ label, value, tone, small, testID }: { label: string; value: string; tone: "neutral" | "warning" | "danger"; small?: boolean; testID?: string }) {
  const color = tone === "danger" ? colors.danger : tone === "warning" ? colors.warningStrong : colors.text;
  return (
    <View style={styles.stat} testID={testID}>
      <Text style={[styles.statValue, small && styles.statValueSmall, { color }]} numberOfLines={1} testID={testID ? `${testID}-value` : undefined}>
        {value}
      </Text>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function OutboxCard({
  item,
  now,
  busy,
  branchName,
  otherUser,
  productName,
  onRetry,
  onEdit,
  onSellAnyway,
  onDiscard,
}: {
  item: OutboxItem;
  now: number;
  busy: boolean;
  branchName: string | null;
  /** Rung by a different account on this device than the one signed in. */
  otherUser: boolean;
  productName: (id: string) => string | null;
  onRetry?: (item: OutboxItem) => void;
  onEdit?: (item: OutboxItem) => void;
  /** §6.5 oversell resolution — only passed for INSUFFICIENT_STOCK rows. */
  onSellAnyway?: (item: OutboxItem) => void;
  onDiscard?: (item: OutboxItem) => void;
}) {
  const isSale = item.kind === SALE_KIND;
  const sale = describeSalePayload(isSale ? (item.payload as SalePayload) : null, productName);
  const status = item.status;
  const error = status === "done" ? null : errorCopy(item);
  const nextTry = status === "queued" ? inFuture(item.nextAttemptAt, now) : null;
  const branchMismatch = status === "failed" && isBranchMismatchRow(item);
  // What a failed sale can do: Retry (same key / re-keyed) or only Edit.
  const mode: SaleRetryMode | null = isSale && status === "failed" ? saleRetryMode(item) : null;
  const showRetry = !!onRetry && mode !== "edit";
  const showEdit = !!onEdit && status === "failed";
  const showSellAnyway = !!onSellAnyway && status === "failed";
  // The short-stock hint is keyed on the refusal, not on the action (the
  // action itself is gated by canSellAnyway in the parent — see offline/sales.ts).
  const shortStock = isOversellRefusal(item);
  const productGone = status === "failed" && item.lastErrorCode === "PRODUCT_NOT_FOUND";
  const customer = [sale.customerName, sale.customerPhone].filter(Boolean).join(" · ");

  return (
    <Card style={styles.item}>
      <View style={styles.itemHead}>
        <View style={styles.itemHeadText}>
          <Text style={styles.itemKind}>{isSale ? t("mobile.sync.kind.sale") : t("mobile.sync.kind.other")}</Text>
          <Text style={styles.itemInvoice} numberOfLines={1}>
            {sale.invoiceId ?? item.idempotencyKey}
          </Text>
        </View>
        <View style={styles.itemHeadEnd}>
          {isSale ? <Text style={styles.itemTotal}>{money(sale.total)}</Text> : null}
          <StatusBadge status={status} />
        </View>
      </View>

      <Text style={styles.itemMeta}>
        {[
          isSale ? t("mobile.sync.items", { n: sale.itemCount }) : null,
          ago(item.createdAt, now),
          t("mobile.sync.attempts", { n: item.attempts }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {isSale && sale.lines.length > 0 ? (
        <View style={styles.lines}>
          {sale.lines.map((l) => (
            <View key={l.productId} style={styles.line}>
              <Text numberOfLines={1} style={styles.lineName}>
                {l.name ?? t("mobile.sync.unknownProduct")} ×{l.quantity}
              </Text>
              <Text style={styles.lineAmt}>{money(l.lineTotal)}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {customer ? <Text style={styles.itemDetail}>{t("mobile.sync.customer", { who: customer })}</Text> : null}
      {branchName ? <Text style={styles.itemDetail}>{t("mobile.sync.branch", { name: branchName })}</Text> : null}
      {otherUser ? <Text style={styles.itemDetail}>{t("mobile.sync.otherCashier")}</Text> : null}

      {error ? (
        <View style={[styles.errorBox, status === "failed" ? styles.errorBoxFailed : styles.errorBoxSoft]}>
          {status === "failed" ? (
            <WarningCircle size={18} color={colors.danger} weight="fill" />
          ) : (
            <CloudSlash size={18} color={colors.warningStrong} weight="fill" />
          )}
          <View style={styles.errorText}>
            <Text style={[styles.errorLine, { color: status === "failed" ? colors.danger : colors.warningStrong }]}>{error}</Text>
            {shortStock ? (
              <Text style={styles.errorDetail}>{t("mobile.sync.oversellHint")}</Text>
            ) : productGone ? (
              <Text style={styles.errorDetail}>{t("mobile.sync.productGoneHint")}</Text>
            ) : mode === "edit" ? (
              <Text style={styles.errorDetail}>{t("mobile.sync.editHint")}</Text>
            ) : mode === "rekey" ? (
              <Text style={styles.errorDetail}>{t("mobile.sync.rekeyHint")}</Text>
            ) : status === "failed" && item.actionable ? (
              <Text style={styles.errorDetail}>{t("mobile.sync.actionable")}</Text>
            ) : null}
          </View>
        </View>
      ) : status === "queued" && item.attempts === 0 ? (
        <Text style={styles.itemHint}>{t("mobile.sync.noDetail")}</Text>
      ) : null}
      {nextTry ? <Text style={styles.itemHint}>{t("mobile.sync.nextTry", { when: nextTry })}</Text> : null}

      {status !== "done" && status !== "sending" && (showRetry || showEdit || showSellAnyway || onDiscard) ? (
        <View style={styles.itemActions}>
          {showSellAnyway ? (
            <Pressable
              onPress={() => onSellAnyway?.(item)}
              disabled={busy}
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed, busy && styles.actionDisabled]}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.sync.sellAnyway")}
              testID="sync-sell-anyway"
            >
              <ShoppingCartSimple size={18} color={colors.accent} />
              <Text style={styles.actionLabel}>{t("mobile.sync.sellAnyway")}</Text>
            </Pressable>
          ) : null}
          {showRetry ? (
            <Pressable
              onPress={() => onRetry?.(item)}
              disabled={busy}
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed, busy && styles.actionDisabled]}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.sync.retry")}
            >
              <ArrowCounterClockwise size={18} color={colors.accent} />
              <Text style={styles.actionLabel}>{t("mobile.sync.retry")}</Text>
            </Pressable>
          ) : null}
          {showEdit ? (
            <Pressable
              onPress={() => onEdit?.(item)}
              disabled={busy}
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed, busy && styles.actionDisabled]}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.sync.edit")}
            >
              <PencilSimple size={18} color={colors.accent} />
              <Text style={styles.actionLabel}>{t("mobile.sync.edit")}</Text>
            </Pressable>
          ) : null}
          {onDiscard ? (
            <Pressable
              onPress={() => onDiscard(item)}
              disabled={busy}
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed, busy && styles.actionDisabled]}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.sync.discard")}
            >
              <Trash size={18} color={colors.danger} />
              <Text style={[styles.actionLabel, { color: colors.danger }]}>{t("mobile.sync.discard")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function StatusBadge({ status }: { status: OutboxItem["status"] }) {
  switch (status) {
    case "failed":
      return <Badge label={t("mobile.sync.status.failed")} variant="outofstock" />;
    case "sending":
      return <Badge label={t("mobile.sync.status.sending")} variant="accent" />;
    case "done":
      return <Badge label={t("mobile.sync.status.done")} variant="success" />;
    default:
      return <Badge label={t("mobile.sync.status.queued")} variant="lowstock" />;
  }
}

// ─── copy ────────────────────────────────────────────────────────────────────

/** The engine's own codes (outbox.ts) — translated, never shown raw. */
const ENGINE_CODES = new Set(["NO_HANDLER", "BAD_PAYLOAD", "EXCEPTION", "MAX_ATTEMPTS"]);
/** ApiError.kind values the engine stores when the server sent no machine code. */
const KIND_CODES = new Set(["offline", "timeout", "server", "session", "billing", "forbidden", "validation", "notFound", "conflict", "unknown"]);

// Branch-mismatch detection lives in @/offline/branch-mismatch (a leaf module
// so __tests__/branch-mismatch.test.ts can pin the regex to the route's sentence).

/**
 * The last failure in the cashier's words. Mirrors classify.ts: the engine
 * stores either its own code, the server's machine code, or — when the server
 * sent none — the ApiError kind. Unknown server codes fall back to the
 * server's text only when it is Arabic prose (the cart route's own messages);
 * a raw English zod line is never shown to an Arabic-speaking shopkeeper.
 */
function errorCopy(item: OutboxItem): string | null {
  const code = item.lastErrorCode;
  if (!code) return item.status === "failed" ? t("mobile.sync.error.unknown") : null;
  if (isBranchMismatchRow(item)) return t("mobile.sync.error.branchMismatch");
  if (ENGINE_CODES.has(code)) {
    return code === "MAX_ATTEMPTS"
      ? t("mobile.offline.error.MAX_ATTEMPTS", { count: item.attempts })
      : t(`mobile.offline.error.${code}`);
  }
  switch (code) {
    case "INSUFFICIENT_STOCK":
      return t("mobile.pos.insufficientStock");
    case "PRODUCT_NOT_FOUND":
      return t("mobile.pos.productGone");
    case "PRODUCT_WRONG_BRANCH":
      return t("mobile.pos.wrongBranch");
    case "CART_EMPTY":
      return t("mobile.pos.cartEmpty");
    case "INTERNAL":
      return t("mobile.sync.error.server");
    case "TENANT_SUSPENDED":
      return t("mobile.sync.error.tenantSuspended");
    case "SUBSCRIPTION_REQUIRED":
      return t("mobile.sync.error.billing");
    case "PASSWORD_CHANGE_REQUIRED":
      return t("mobile.common.passwordChangeRequired");
    case "TOTP_REQUIRED":
      return t("mobile.sync.pausedReason.totp");
    case "RATE_LIMITED":
    case "rateLimited":
      return t("mobile.sync.error.rateLimited");
    case "credentials":
      return t("mobile.sync.error.session");
  }
  if (KIND_CODES.has(code)) return t(`mobile.sync.error.${code}`);
  if (item.lastErrorText && /[؀-ۿ]/.test(item.lastErrorText)) return item.lastErrorText;
  return t("mobile.sync.error.unknown");
}

function pausedReason(code: string | null): string {
  switch (code) {
    case "session":
    case "credentials":
      return t("mobile.sync.pausedReason.session");
    case "billing":
    case "SUBSCRIPTION_REQUIRED":
    case "TENANT_SUSPENDED":
      return t("mobile.sync.pausedReason.billing");
    case "TOTP_REQUIRED":
      return t("mobile.sync.pausedReason.totp");
    default:
      return t("mobile.sync.pausedReason.other");
  }
}

function drainSummary(r: DrainResult): string {
  if (!r.ran) return t("mobile.sync.result.skipped");
  const parts: string[] = [];
  if (r.sent > 0) parts.push(t("mobile.sync.result.sent", { n: r.sent }));
  if (r.failed > 0) parts.push(t("mobile.sync.result.failed", { n: r.failed }));
  if (r.deferred > 0) parts.push(t("mobile.sync.result.deferred", { n: r.deferred }));
  return parts.length ? parts.join(" · ") : t("mobile.sync.result.nothing");
}

/** Epoch ms → "just now" / "5 min ago" / "2 h ago" / dd/mm/yyyy. No Intl on device. */
function ago(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return t("mobile.sync.ago.now");
  if (d < 3_600_000) return t("mobile.sync.ago.minutes", { n: Math.floor(d / 60_000) });
  if (d < 86_400_000) return t("mobile.sync.ago.hours", { n: Math.floor(d / 3_600_000) });
  return shortDate(new Date(ms).toISOString());
}

function inFuture(ms: number, now: number): string | null {
  const d = ms - now;
  if (d <= 1_000) return null;
  if (d < 60_000) return t("mobile.sync.in.seconds");
  return t("mobile.sync.in.minutes", { n: Math.ceil(d / 60_000) });
}

// ─── styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  stats: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  stat: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    alignItems: "center",
    gap: 2,
  },
  statValue: { fontFamily: fonts.bold, fontSize: 24, fontVariant: ["tabular-nums"] },
  statValueSmall: { fontSize: 15, paddingVertical: 5 },
  statLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  bannerWarning: { backgroundColor: colors.warningTint },
  bannerDanger: { backgroundColor: colors.dangerLight },
  bannerText: { flex: 1, fontFamily: fonts.medium, fontSize: 13, ...RTL_TEXT },
  actions: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  grow: { flex: 1 },
  resultLine: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginBottom: spacing.md, ...RTL_TEXT },
  section: {
    alignSelf: "flex-start",
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    ...RTL_TEXT,
  },
  item: { marginBottom: spacing.sm },
  itemHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.sm },
  itemHeadText: { flex: 1, minWidth: 0, alignItems: "flex-start" },
  itemHeadEnd: { alignItems: "flex-end", gap: 4 },
  itemKind: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  itemInvoice: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  itemTotal: { fontFamily: fonts.bold, fontSize: 16, color: colors.text, fontVariant: ["tabular-nums"] },
  itemMeta: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: spacing.xs, ...RTL_TEXT },
  itemHint: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: spacing.xs, ...RTL_TEXT },
  itemDetail: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: 2, ...RTL_TEXT },
  lines: { marginTop: spacing.sm, gap: 4, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  line: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md },
  lineName: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.text, ...RTL_TEXT },
  lineAmt: { fontFamily: fonts.medium, fontSize: 13, color: colors.text, fontVariant: ["tabular-nums"] },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginTop: spacing.sm,
  },
  errorBoxFailed: { backgroundColor: colors.dangerLight },
  errorBoxSoft: { backgroundColor: colors.warningLight },
  errorText: { flex: 1, gap: 2, alignItems: "flex-start" },
  errorLine: { fontFamily: fonts.medium, fontSize: 13, ...RTL_TEXT },
  errorDetail: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  itemActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: MIN_TOUCH,
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionPressed: { backgroundColor: colors.neutralTint },
  actionDisabled: { opacity: 0.5 },
  actionLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent },
  devCard: { marginTop: spacing.lg, borderStyle: "dashed", borderColor: colors.warningStrong },
  devTitle: { alignSelf: "flex-start", fontFamily: fonts.bold, fontSize: 13, color: colors.warningStrong, marginBottom: spacing.sm, ...RTL_TEXT },
  devRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  devBody: { flex: 1, alignItems: "flex-start" },
  devLabel: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  devHint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: 2, ...RTL_TEXT },
});
