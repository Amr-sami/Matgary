/**
 * Sale alerts (doc 16 §6): a tiny in-tab bus between the notification stream
 * (hooks/useNotifications.ts, `event: sale_alert`) and <SaleAlertToaster/>.
 *
 * Plus the pure decision logic the toaster runs on every alert, kept here so
 * tests/unit/sale-alert-bus.test.ts can drive it with plain objects:
 *  - its own tab's alert (origin === TAB_ORIGIN) is skipped entirely;
 *  - one alert toasts in EVERY open tab, but chimes in only ONE — the first
 *    tab to claim `localStorage["storo:sale-alert:<id>"]`; claims older than
 *    60 s are purged; a storage failure means "play anyway";
 *  - chimes are throttled to >= 1.5 s apart within a tab.
 */

/** Wire shape of the SSE payload (mirrors SaleAlertEvent in lib/notifications/events.ts). */
export interface SaleAlert {
  t: "sale_alert";
  /** Anchor sale line id, or `summary:<ts>` for a burst summary. */
  id: string;
  title: string;
  body: string | null;
  link: string;
  /** The recording tab's `web:<uuid>`, or null (a phone, or a summary). */
  origin: string | null;
}

type Listener = (alert: SaleAlert) => void;
const listeners = new Set<Listener>();

/** Parse an SSE `data:` string into a SaleAlert, or null when it is not one. */
export function parseSaleAlert(data: string): SaleAlert | null {
  try {
    const v = JSON.parse(data) as Partial<SaleAlert> | null;
    if (
      v &&
      v.t === "sale_alert" &&
      typeof v.id === "string" &&
      v.id.length > 0 &&
      typeof v.title === "string"
    ) {
      return {
        t: "sale_alert",
        id: v.id,
        title: v.title,
        body: typeof v.body === "string" ? v.body : null,
        link: typeof v.link === "string" && v.link.startsWith("/") ? v.link : "/sales",
        origin: typeof v.origin === "string" ? v.origin : null,
      };
    }
  } catch {
    // malformed frame
  }
  return null;
}

export function emitSaleAlert(alert: SaleAlert): void {
  for (const l of [...listeners]) {
    try {
      l(alert);
    } catch {
      // one bad listener must not stop the others
    }
  }
}

export function subscribeSaleAlerts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const CLAIM_PREFIX = "storo:sale-alert:";
export const CLAIM_TTL_MS = 60_000;
export const CHIME_MIN_GAP_MS = 1_500;
export const TOAST_MS = 6_000;
export const MAX_TOASTS = 3;

/** The part of Storage the claim needs (window.localStorage in the browser). */
export interface ClaimStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Claim the chime for alert `id` across this browser's tabs. True = this tab
 * plays it. Purges claims older than CLAIM_TTL_MS first, so the store never
 * grows. Any storage error (private mode, quota, disabled) → true: a double
 * chime beats a missed sale.
 *
 * Not atomic across tabs (localStorage has no CAS); two tabs racing inside
 * the same few ms may both chime. Writing then re-reading our own token
 * narrows that window to the rare exact interleave.
 */
export function claimChime(
  storage: ClaimStorage | null | undefined,
  id: string,
  now: number,
  token: string = `${now}:${Math.random().toString(36).slice(2)}`,
): boolean {
  if (!storage) return true;
  try {
    for (let i = storage.length - 1; i >= 0; i--) {
      const k = storage.key(i);
      if (!k || !k.startsWith(CLAIM_PREFIX)) continue;
      const at = Number((storage.getItem(k) ?? "").split(":")[0]);
      if (!Number.isFinite(at) || now - at > CLAIM_TTL_MS) storage.removeItem(k);
    }
    const key = CLAIM_PREFIX + id;
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, token);
    return storage.getItem(key) === token;
  } catch {
    return true;
  }
}

/** Chime throttle: at most one chime per CHIME_MIN_GAP_MS in this tab. */
export class ChimeThrottle {
  private last = -Infinity;
  constructor(private readonly gapMs = CHIME_MIN_GAP_MS) {}
  tryAcquire(now: number): boolean {
    if (now - this.last < this.gapMs) return false;
    this.last = now;
    return true;
  }
}

export interface SaleAlertDecision {
  /** Show the toast in this tab. */
  toast: boolean;
  /** Play the chime in this tab. */
  chime: boolean;
}

/**
 * What one tab does with one alert. `seen` dedupes a frame delivered twice
 * to the same tab (an SSE reconnect replay); the caller owns it.
 */
export function decideSaleAlert(
  alert: SaleAlert,
  ctx: {
    tabOrigin: string;
    seen: Set<string>;
    storage: ClaimStorage | null | undefined;
    throttle: ChimeThrottle;
    now: number;
  },
): SaleAlertDecision {
  if (alert.origin && alert.origin === ctx.tabOrigin) return { toast: false, chime: false };
  if (ctx.seen.has(alert.id)) return { toast: false, chime: false };
  ctx.seen.add(alert.id);
  // Bound the per-tab memory; ids older than the last 200 cannot replay.
  if (ctx.seen.size > 200) {
    const first = ctx.seen.values().next().value;
    if (first !== undefined) ctx.seen.delete(first);
  }
  const claimed = claimChime(ctx.storage, alert.id, ctx.now);
  const chime = claimed && ctx.throttle.tryAcquire(ctx.now);
  return { toast: true, chime };
}

/** Append a toast, newest last, keeping at most MAX_TOASTS. */
export function pushToast<T extends { id: string }>(list: readonly T[], next: T, max = MAX_TOASTS): T[] {
  const without = list.filter((x) => x.id !== next.id);
  const out = [...without, next];
  return out.length > max ? out.slice(out.length - max) : out;
}
