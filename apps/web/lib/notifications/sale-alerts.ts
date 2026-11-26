// Sale alerts — the "cha-ching" on every shop device (mobile-dev-docs/16-sale-alerts.md).
//
// Called fire-and-forget by the two sale producers (lib/repo/operations.ts
// `recordSale` / `recordCartSaleImpl`) AFTER their transaction returned, so
// the sale has committed and no `waitForCommit` is needed. One call:
//
//   1. kill switch (SALE_ALERTS_DISABLED=1) and the back-date rule;
//   2. one tenant-scoped read: recipients (owner + same-branch staff holding
//      view_sales), their `sale.alert` preference rows, the seller's name,
//      `tenants.timezone`, and every live push token except the device that
//      recorded the sale (`X-Alert-Origin`);
//   3. the burst gate — more than SALE_ALERT_BURST_N sales from one branch in
//      a minute collapse into one summary ~30 s later;
//   4. one Expo send (sound cha_ching.wav, Android channel `sales`, ttl 900),
//      outcomes applied per user (dead tokens disabled, tickets queued);
//   5. a Redis publish per opted-in recipient for open dashboard tabs.
//
// Copy is rendered here per recipient language (the dispatch.ts convention,
// not i18n JSON). It never names the customer (doc 15 Q18: push text leaves
// the country through Apple and Google). Sale alerts write NO `notifications`
// row — a cashier's bell is not flooded; the owner keeps the `sale.created`
// bell row.

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { notificationPreferences, pushTokens, tenantMembers, tenants, users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { publishUserSaleAlert } from "@/lib/notifications/events";
import { countAr, fmtEgp, joinParts, methodName } from "@/lib/notifications/dispatch";
import { isExpoPushToken, sendPush, type PushData, type PushMessage, type PushOutcome } from "@/lib/push/expo-push";
import { handleOutcomes } from "@/lib/push/notify";
import { redis as sharedRedis } from "@/lib/redis";
import type { PaymentMethod } from "@/lib/types";

// ─── Bindings (doc 16 §10) ───────────────────────────────────────────────────

/** Android channel. Must equal SALES_CHANNEL in apps/mobile/src/effects/PushRegistrar.tsx. */
export const SALE_ALERT_CHANNEL = "sales" as const;
/** Sound file. Must equal SALE_SOUND in PushRegistrar.tsx and the asset names
 *  apps/mobile/assets/sounds/cha_ching.wav + apps/web/public/sounds/cha_ching.wav. */
export const SALE_ALERT_SOUND = "cha_ching.wav" as const;
export const SALE_ALERT_EVENT = "sale.alert" as const;
export const SALE_ALERT_BURST_N = 3;
export const SALE_ALERT_BURST_WINDOW_MS = 60_000;
export const SALE_ALERT_SUMMARY_DELAY_MS = 30_000;
export const SALE_ALERT_TTL_SEC = 900;
export const SALE_ALERT_OFFLINE_MIN_AGE_MS = 60_000;
export const SALE_ALERT_MAX_BACKDATE_MS = 86_400_000;
export const SALE_ALERT_PERMISSION = "view_sales" as const;
/** OPEN-1: returns do not ring. Not wired today. */
export const SALE_ALERT_RETURNS = false;

/** TTL of the burst ZSET, the pending list and the summary claim. */
const BURST_KEY_TTL_MS = 120_000;
const PENDING_KEY_TTL_MS = 600_000;
const SUMMARY_CLAIM_TTL_MS = 35_000;

const WEB_ORIGIN_RE = /^web:[0-9a-f-]{36}$/i;

/** The `X-Alert-Origin` header value when it is an Expo push token or a
 *  `web:<uuid>` tab origin; anything else is ignored (null). */
export function parseAlertOrigin(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (isExpoPushToken(s)) return s;
  if (WEB_ORIGIN_RE.test(s)) return s;
  return null;
}

// ─── Copy (pure) ─────────────────────────────────────────────────────────────

export type SaleAlertLocale = "ar" | "en";

export interface SaleAlertCopyInput {
  invoiceId: string;
  total: number;
  itemCount: number;
  paymentMethod: PaymentMethod;
  /** First word of the seller's display name; null/empty → part omitted. */
  sellerName: string | null;
  branchName: string | null;
  /** Primary product name — on a single-line sale this is "the" product;
   *  on a cart sale it is the first line (added for the v2 user-visible body
   *  copy, 2026-10-25). Null → the product line is omitted from the body. */
  firstProductName: string | null;
  /** How many DISTINCT product lines are in the sale. 1 → body shows just
   *  the product name; 2+ → body shows "{first} +{N-1} more". itemCount is
   *  the total quantity across lines and is still used for the summary. */
  lineCount: number;
  /** When the sale was rung up offline and synced later: its time. */
  offlineAt: Date | null;
  /** IANA zone for the offline time (tenants.timezone). */
  timeZone: string;
}

export interface RenderedAlert {
  title: string;
  body: string;
}

function paymentLabel(m: PaymentMethod, ar: boolean): string | null {
  switch (m) {
    case "cash":
      return null;
    case "instapay":
    case "wallet":
      return methodName(m, ar);
    case "card":
      return ar ? "فيزا" : "Card";
    case "deferred":
      return ar ? "آجل" : "On credit";
    default:
      return null;
  }
}

function branchLabel(name: string | null | undefined, ar: boolean): string | null {
  const n = name?.trim();
  if (!n) return null;
  if (!ar) return n;
  // "الفرع الرئيسي" / "فرع المعادي" already say branch — never «فرع الفرع …».
  return /فرع/.test(n) ? n : `فرع ${n}`;
}

/** "2:32 PM" (en) / "2:32 م" (ar) in `timeZone`, 12 h, Western digits. */
export function clockTime(d: Date, timeZone: string, ar: boolean): string {
  let s: string;
  try {
    s = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(d);
  } catch {
    s = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Africa/Cairo",
    }).format(d);
  }
  // Some ICU builds put a narrow no-break space before the day period.
  s = s.replace(/\s+/g, " ");
  if (!ar) return s;
  return s.replace(/\bAM\b/, "ص").replace(/\bPM\b/, "م");
}

export function firstName(name: string | null | undefined): string | null {
  const w = (name ?? "").trim().split(/\s+/)[0];
  return w ? w : null;
}

export function renderSaleAlert(locale: SaleAlertLocale, p: SaleAlertCopyInput): RenderedAlert {
  const ar = locale === "ar";
  const seller = firstName(p.sellerName);
  const otherLines = Math.max(0, Math.round(p.lineCount - 1));
  // The product phrase — v2 copy (2026-10-25): the body leads with WHAT sold
  // rather than the invoice number. Tapping the push still opens the invoice
  // (route = /sales/{saleId}), so the full line list is one tap away.
  const productPhrase = p.firstProductName
    ? otherLines > 0
      ? ar
        ? `${p.firstProductName} +${otherLines} أخرى`
        : `${p.firstProductName} +${otherLines} more`
      : p.firstProductName
    : null;
  const parts = [
    productPhrase,
    paymentLabel(p.paymentMethod, ar),
    seller && (ar ? `سجّلها ${seller}` : `by ${seller}`),
    branchLabel(p.branchName, ar),
    p.offlineAt &&
      (ar
        ? `اتسجّلت أوفلاين الساعة ${clockTime(p.offlineAt, p.timeZone, true)}`
        : `recorded offline at ${clockTime(p.offlineAt, p.timeZone, false)}`),
  ];
  return ar
    ? { title: `بيع جديد · ${fmtEgp(p.total)} ج.م`, body: joinParts(parts) }
    : { title: `New sale · EGP ${fmtEgp(p.total)}`, body: joinParts(parts) };
}

export function renderSaleSummary(
  locale: SaleAlertLocale,
  p: { count: number; total: number; branchName: string | null },
): RenderedAlert {
  const ar = locale === "ar";
  const n = Math.max(1, Math.round(p.count));
  return ar
    ? {
        title: `${countAr(n, "بيعة جديدة", "بيعتين جداد", "بيعات جديدة", "بيعة جديدة")} · ${fmtEgp(p.total)} ج.م`,
        body: joinParts(["في آخر دقيقة", branchLabel(p.branchName, true)]),
      }
    : {
        title: `${n} new sale${n === 1 ? "" : "s"} · EGP ${fmtEgp(p.total)}`,
        body: joinParts(["In the last minute", branchLabel(p.branchName, false)]),
      };
}

// ─── Burst store ─────────────────────────────────────────────────────────────

/** Sliding-window counter + pending summary list per `(tenant, branch)` key. */
export interface BurstStore {
  /** Add the sale to the 60 s window and return how many sales it now holds. */
  record(key: string, saleId: string, now: number): Promise<number>;
  /** Queue a burst sale's total for the next summary. */
  pushPending(key: string, total: number): Promise<void>;
  /** True for exactly one caller until `releaseSummary` (or the claim TTL). */
  claimSummary(key: string, now: number): Promise<boolean>;
  /** Take every queued total, leaving the list empty. */
  drainPending(key: string): Promise<number[]>;
  releaseSummary(key: string): Promise<void>;
}

/** In-process store: dev without Redis, and tests. */
export class MemoryBurstStore implements BurstStore {
  private windows = new Map<string, Array<{ at: number; id: string }>>();
  private pending = new Map<string, number[]>();
  private claims = new Map<string, number>();

  async record(key: string, saleId: string, now: number): Promise<number> {
    const w = (this.windows.get(key) ?? []).filter((e) => e.at > now - SALE_ALERT_BURST_WINDOW_MS);
    if (!w.some((e) => e.id === saleId)) w.push({ at: now, id: saleId });
    this.windows.set(key, w);
    return w.length;
  }

  async pushPending(key: string, total: number): Promise<void> {
    const list = this.pending.get(key) ?? [];
    list.push(total);
    this.pending.set(key, list);
  }

  async claimSummary(key: string, now: number): Promise<boolean> {
    const until = this.claims.get(key);
    if (until !== undefined && until > now) return false;
    this.claims.set(key, now + SUMMARY_CLAIM_TTL_MS);
    return true;
  }

  async drainPending(key: string): Promise<number[]> {
    const list = this.pending.get(key) ?? [];
    this.pending.delete(key);
    return list;
  }

  async releaseSummary(key: string): Promise<void> {
    this.claims.delete(key);
  }
}

type RedisLike = NonNullable<typeof sharedRedis>;

/** Production store (doc 16 §3): ZSET window, LIST of totals, NX claim. */
export class RedisBurstStore implements BurstStore {
  constructor(private readonly r: RedisLike) {}

  async record(key: string, saleId: string, now: number): Promise<number> {
    const k = `salealert:burst:${key}`;
    const res = await this.r
      .multi()
      .zremrangebyscore(k, 0, now - SALE_ALERT_BURST_WINDOW_MS)
      .zadd(k, now, saleId)
      .zcard(k)
      .pexpire(k, BURST_KEY_TTL_MS)
      .exec();
    const card = res?.[2]?.[1];
    return typeof card === "number" ? card : Number(card ?? 1);
  }

  async pushPending(key: string, total: number): Promise<void> {
    const k = `salealert:pending:${key}`;
    await this.r.multi().rpush(k, JSON.stringify({ total })).pexpire(k, PENDING_KEY_TTL_MS).exec();
  }

  async claimSummary(key: string): Promise<boolean> {
    const ok = await this.r.set(`salealert:summary:${key}`, "1", "PX", SUMMARY_CLAIM_TTL_MS, "NX");
    return ok === "OK";
  }

  async drainPending(key: string): Promise<number[]> {
    const k = `salealert:pending:${key}`;
    const res = await this.r.multi().lrange(k, 0, -1).del(k).exec();
    const raw = (res?.[0]?.[1] as string[] | undefined) ?? [];
    return raw.map((s) => {
      try {
        const v = JSON.parse(s) as { total?: unknown };
        return typeof v.total === "number" && Number.isFinite(v.total) ? v.total : 0;
      } catch {
        return 0;
      }
    });
  }

  async releaseSummary(key: string): Promise<void> {
    await this.r.del(`salealert:summary:${key}`);
  }
}

const globalForStore = globalThis as unknown as { __saleAlertMemoryStore?: MemoryBurstStore };

function defaultStore(): BurstStore {
  if (sharedRedis) return new RedisBurstStore(sharedRedis);
  globalForStore.__saleAlertMemoryStore ??= new MemoryBurstStore();
  return globalForStore.__saleAlertMemoryStore;
}

// ─── Audience ────────────────────────────────────────────────────────────────

interface Recipient {
  userId: string;
  locale: SaleAlertLocale;
}

interface Audience {
  /** Opted-in recipients (stored `sale.alert.push` not false). */
  recipients: Recipient[];
  /** Live tokens of those recipients, origin token excluded. */
  tokens: Array<{ userId: string; token: string }>;
  sellerName: string | null;
  timeZone: string;
}

async function loadAudience(
  tenantId: string,
  branchId: string,
  sellerUserId: string | null,
  originToken: string | null,
): Promise<Audience> {
  return withTenant(tenantId, async (tx) => {
    // v2 fanout (owner's call, 2026-10-25): every member of the branch rings,
    // not only the ones holding `view_sales`. Rationale: the owner wants a
    // cashier/stock clerk to hear sales from their own branch regardless of
    // whether they can OPEN the sales screen. Branch is still enforced — a
    // Maadi cashier should not be interrupted by a Nasr City sale.
    const members = await tx
      .select({ userId: tenantMembers.userId, locale: users.locale })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          or(
            eq(tenantMembers.role, "owner"),
            and(eq(tenantMembers.role, "staff"), eq(tenantMembers.branchId, branchId)),
          ),
        ),
      );

    const [tenantRow] = await tx
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const timeZone = tenantRow?.timezone || "Africa/Cairo";

    let sellerName: string | null = null;
    if (sellerUserId) {
      const [s] = await tx
        .select({ displayName: tenantMembers.displayName, name: users.name })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, sellerUserId)))
        .limit(1);
      sellerName = firstName(s?.displayName?.trim() ? s.displayName : (s?.name ?? null));
    }

    if (members.length === 0) return { recipients: [], tokens: [], sellerName, timeZone };
    const ids = members.map((m) => m.userId);

    const muted = await tx
      .select({ userId: notificationPreferences.userId })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.tenantId, tenantId),
          eq(notificationPreferences.eventType, SALE_ALERT_EVENT),
          eq(notificationPreferences.push, false),
          inArray(notificationPreferences.userId, ids),
        ),
      );
    const mutedSet = new Set(muted.map((m) => m.userId));
    const recipients: Recipient[] = members
      .filter((m) => !mutedSet.has(m.userId))
      .map((m) => ({ userId: m.userId, locale: m.locale === "en" ? "en" : "ar" }));
    if (recipients.length === 0) return { recipients, tokens: [], sellerName, timeZone };

    // v2 (owner's call, 2026-10-25): the recording device IS included. The
    // originToken param is kept for callers but no longer filtered on.
    void originToken;
    const tokenRows = await tx
      .select({ userId: pushTokens.userId, token: pushTokens.expoToken })
      .from(pushTokens)
      .where(
        and(
          eq(pushTokens.tenantId, tenantId),
          inArray(
            pushTokens.userId,
            recipients.map((r) => r.userId),
          ),
          isNull(pushTokens.disabledAt),
        ),
      )
      .orderBy(pushTokens.createdAt);
    return { recipients, tokens: tokenRows, sellerName, timeZone };
  });
}

// ─── Delivery ────────────────────────────────────────────────────────────────

export interface SaleAlertInput {
  tenantId: string;
  branchId: string;
  branchName: string | null;
  /** Anchor sale LINE id (the cart's first row) — the mobile detail route. */
  saleId: string;
  invoiceId: string;
  total: number;
  itemCount: number;
  paymentMethod: PaymentMethod;
  sellerUserId: string | null;
  saleDate: Date;
  /** Primary product name — single-sale: the product; cart sale: lines[0]. */
  firstProductName: string | null;
  /** How many DISTINCT product lines are in the sale (used to render
   *  "{first} +N أخرى" when the cart carries more than one product). */
  lineCount: number;
  /** Parsed `X-Alert-Origin`: the recording device's Expo token or `web:<uuid>`.
   *  v2 (2026-10-25): kept for the summary + web-tab dedupe path, no longer
   *  used to exclude the device's push token. */
  origin: string | null;
  /** `X-Outbox-Replay: 1` — an offline sale syncing now. */
  outboxReplay: boolean;
}

export interface SaleAlertOptions {
  /** Test seam passed to sendPush. */
  fetch?: typeof fetch;
  store?: BurstStore;
  now?: () => number;
  /** Test seam for the summary timer; defaults to an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
}

function defaultSchedule(fn: () => void, ms: number): void {
  const timer = setTimeout(fn, ms);
  (timer as { unref?: () => void }).unref?.();
}

/** Per-recipient copy, rendered once per locale. */
type Renderer = (locale: SaleAlertLocale) => RenderedAlert;

async function deliver(
  tenantId: string,
  audience: Audience,
  render: Renderer,
  data: PushData,
  web: { id: string; origin: string | null },
  opts: SaleAlertOptions,
): Promise<{ outcomes: PushOutcome[] }> {
  const localeOf = new Map(audience.recipients.map((r) => [r.userId, r.locale]));
  const copy: Record<SaleAlertLocale, RenderedAlert | undefined> = { ar: undefined, en: undefined };
  const copyFor = (l: SaleAlertLocale) => (copy[l] ??= render(l));

  const messages: PushMessage[] = [];
  const owners: string[] = [];
  for (const t of audience.tokens) {
    const c = copyFor(localeOf.get(t.userId) ?? "ar");
    messages.push({
      to: t.token,
      title: c.title,
      body: c.body,
      data,
      channelId: SALE_ALERT_CHANNEL,
      sound: SALE_ALERT_SOUND,
      ttl: SALE_ALERT_TTL_SEC,
    });
    owners.push(t.userId);
  }

  // Debug only (dev default level; prod logs at info): the exact Expo wire
  // fields, tokens masked — "what would be sent" without Expo credentials.
  if (messages.length > 0) {
    logger.debug({
      event: "salealert.wire",
      tenantId,
      messages: messages.map((m) => ({
        to: m.to.slice(0, 24) + "…",
        title: m.title,
        body: m.body,
        sound: m.sound,
        channelId: m.channelId,
        ttl: m.ttl,
        data: m.data,
      })),
    });
  }
  const outcomes = messages.length > 0 ? await sendPush(messages, { fetch: opts.fetch }) : [];
  const byUser = new Map<string, PushOutcome[]>();
  outcomes.forEach((o, i) => {
    const u = owners[i];
    if (!u) return;
    const list = byUser.get(u) ?? [];
    list.push(o);
    byUser.set(u, list);
  });
  for (const [userId, outs] of byUser) {
    try {
      await handleOutcomes(tenantId, userId, outs);
    } catch (err) {
      logger.warn({
        event: "salealert.outcomes_failed",
        tenantId,
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Open dashboard tabs — every opted-in recipient, phones or not. Only a
  // `web:` origin is forwarded (publishUserSaleAlert drops anything else).
  await Promise.all(
    audience.recipients.map((r) => {
      const c = copyFor(r.locale);
      return publishUserSaleAlert(r.userId, {
        id: web.id,
        title: c.title,
        body: c.body,
        link: "/sales",
        origin: web.origin,
      });
    }),
  );
  return { outcomes };
}

/** In-flight summary flushes — awaited by tests (`settleSaleAlerts`). */
const inFlight = new Set<Promise<void>>();

/** Resolve once every scheduled-and-fired summary flush has finished. */
export async function settleSaleAlerts(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

async function flushSummary(
  tenantId: string,
  branchId: string,
  branchName: string | null,
  store: BurstStore,
  opts: SaleAlertOptions,
): Promise<void> {
  const key = `${tenantId}:${branchId}`;
  try {
    // Release the claim BEFORE draining: a burst sale landing after this
    // point claims a fresh flush instead of waiting in the list for the next
    // burst (an entry it adds before the drain is simply taken by this one,
    // and that later flush then finds nothing to send).
    await store.releaseSummary(key);
    const totals = await store.drainPending(key);
    if (totals.length === 0) return;
    const sum = totals.reduce((a, b) => a + b, 0);
    const audience = await loadAudience(tenantId, branchId, null, null);
    const now = (opts.now ?? Date.now)();
    const data: PushData = {
      type: "sale_alert_summary",
      route: "/sales/history",
      id: null,
      link: "/sales",
      tenantId,
      branchId,
    };
    const { outcomes } = await deliver(
      tenantId,
      audience,
      (l) => renderSaleSummary(l, { count: totals.length, total: sum, branchName }),
      data,
      { id: `summary:${now}`, origin: null },
      opts,
    );
    logger.info({
      event: "salealert.sent",
      tenantId,
      recipients: audience.recipients.length,
      tokens: outcomes.length,
      burst: "summary",
      count: totals.length,
    });
  } catch (err) {
    logger.error({
      event: "salealert.summary_failed",
      tenantId,
      branchId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Ring every shop device about one completed sale. Never throws.
 * Resolves after the single alert was sent (or queued for a summary).
 */
export async function alertSale(input: SaleAlertInput, opts: SaleAlertOptions = {}): Promise<void> {
  try {
    if (process.env.SALE_ALERTS_DISABLED === "1") return;
    const now = (opts.now ?? Date.now)();
    const age = now - input.saleDate.getTime();
    // OPEN-4: a back-dated entry (paper invoices typed in later) is not news.
    if (!input.outboxReplay && age > SALE_ALERT_MAX_BACKDATE_MS) return;

    const store = opts.store ?? defaultStore();
    const key = `${input.tenantId}:${input.branchId}`;
    let count = 1;
    try {
      count = await store.record(key, input.saleId, now);
    } catch (err) {
      // Fail open: a broken burst store means individual alerts.
      logger.warn({
        event: "salealert.burst_store_failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    if (count > SALE_ALERT_BURST_N) {
      await store.pushPending(key, input.total);
      if (await store.claimSummary(key, now)) {
        (opts.schedule ?? defaultSchedule)(() => {
          const p = flushSummary(input.tenantId, input.branchId, input.branchName, store, opts).finally(() =>
            inFlight.delete(p),
          );
          inFlight.add(p);
        }, SALE_ALERT_SUMMARY_DELAY_MS);
      }
      logger.info({ event: "salealert.queued", tenantId: input.tenantId, burst: count });
      return;
    }

    const originToken = input.origin && isExpoPushToken(input.origin) ? input.origin : null;
    const webOrigin = input.origin && input.origin.startsWith("web:") ? input.origin : null;
    const audience = await loadAudience(input.tenantId, input.branchId, input.sellerUserId, originToken);
    if (audience.recipients.length === 0) return;

    const offlineAt =
      input.outboxReplay && age > SALE_ALERT_OFFLINE_MIN_AGE_MS ? input.saleDate : null;
    const data: PushData = {
      type: "sale_alert",
      route: `/sales/${input.saleId}`,
      id: input.saleId,
      link: "/sales",
      tenantId: input.tenantId,
      branchId: input.branchId,
      invoiceId: input.invoiceId,
    };
    const { outcomes } = await deliver(
      input.tenantId,
      audience,
      (l) =>
        renderSaleAlert(l, {
          invoiceId: input.invoiceId,
          total: input.total,
          itemCount: input.itemCount,
          paymentMethod: input.paymentMethod,
          sellerName: audience.sellerName,
          branchName: input.branchName,
          firstProductName: input.firstProductName,
          lineCount: input.lineCount,
          offlineAt,
          timeZone: audience.timeZone,
        }),
      data,
      { id: input.saleId, origin: webOrigin },
      opts,
    );
    logger.info({
      event: "salealert.sent",
      tenantId: input.tenantId,
      recipients: audience.recipients.length,
      tokens: outcomes.length,
      burst: count,
    });
  } catch (err) {
    logger.error({
      event: "salealert.failed",
      tenantId: input.tenantId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
