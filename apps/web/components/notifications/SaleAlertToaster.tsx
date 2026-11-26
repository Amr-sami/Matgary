"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ShoppingCart, X } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import {
  ChimeThrottle,
  decideSaleAlert,
  pushToast,
  subscribeSaleAlerts,
  TOAST_MS,
  type ClaimStorage,
  type SaleAlert,
} from "@/lib/sale-alerts/bus";
import { installChimePrimer, playChime, primeChime } from "@/lib/sale-alerts/chime";
import { getTabOrigin } from "@/lib/sale-alerts/origin";

/**
 * Sale alerts in an open dashboard tab (mobile-dev-docs/16-sale-alerts.md §6):
 * a toast + the cha-ching for every sale recorded on ANOTHER device or tab.
 *
 * Mounted once by AppShell. Alerts arrive on the bus from the notification
 * stream (hooks/useNotifications.ts → `event: sale_alert`). The decisions
 * (own tab skipped, one chime per alert across tabs, 1.5 s throttle) live in
 * lib/sale-alerts/bus.ts and are unit-tested there.
 *
 * Autoplay: the chime is primed on the first click/keypress in the page. If
 * the browser still blocks it, the toast shows "Turn on sound", which primes
 * and plays inside that click.
 */

interface ToastItem {
  id: string;
  title: string;
  body: string | null;
  link: string;
}

// Module scope: AppShell is rendered per page, so the toaster remounts on
// navigation — the dedupe set and the throttle must outlive that.
const seen = new Set<string>();
const throttle = new ChimeThrottle();

function storage(): ClaimStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function SaleAlertToaster() {
  const dict = useDictionary();
  const t = dict.app.saleAlerts;
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [blocked, setBlocked] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const tm = timers.current.get(id);
    if (tm) clearTimeout(tm);
    timers.current.delete(id);
    setToasts((cur) => cur.filter((x) => x.id !== id));
  }, []);

  useEffect(() => installChimePrimer(), []);

  useEffect(() => {
    const live = timers.current;
    const unsubscribe = subscribeSaleAlerts((alert: SaleAlert) => {
      const d = decideSaleAlert(alert, {
        tabOrigin: getTabOrigin(),
        seen,
        storage: storage(),
        throttle,
        now: Date.now(),
      });
      if (!d.toast) return;
      setToasts((cur) =>
        pushToast(cur, { id: alert.id, title: alert.title, body: alert.body, link: alert.link }),
      );
      const prev = live.get(alert.id);
      if (prev) clearTimeout(prev);
      live.set(
        alert.id,
        setTimeout(() => {
          live.delete(alert.id);
          setToasts((cur) => cur.filter((x) => x.id !== alert.id));
        }, TOAST_MS),
      );
      if (d.chime) {
        void playChime().then((ok) => setBlocked(!ok));
      }
    });
    return () => {
      unsubscribe();
      for (const tm of live.values()) clearTimeout(tm);
      live.clear();
    };
  }, []);

  const enableSound = useCallback(() => {
    // Inside the click: prime, then play — both count as user-activated.
    primeChime();
    void playChime().then((ok) => setBlocked(!ok));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-[calc(env(safe-area-inset-top)+1rem)] end-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 no-print"
      aria-live="polite"
    >
      {toasts.map((x, i) => (
        <div
          key={x.id}
          role="status"
          data-testid="sale-alert-toast"
          className="rounded-xl border border-success/20 bg-white shadow-lg p-3 flex items-start gap-3 animate-in slide-in-from-end-4"
        >
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success-light text-success">
            <ShoppingCart className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary">{x.title}</p>
            {x.body ? <p className="mt-0.5 text-xs text-text-secondary break-words">{x.body}</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Link
                href={x.link}
                onClick={() => dismiss(x.id)}
                className="text-xs font-medium text-accent hover:underline"
              >
                {t.view}
              </Link>
              {blocked && i === toasts.length - 1 ? (
                <button
                  type="button"
                  data-testid="sale-alert-enable-sound"
                  onClick={enableSound}
                  title={t.soundBlocked}
                  className="text-xs font-medium rounded-md border border-border px-2 py-1 text-text-primary hover:bg-bg-main"
                >
                  {t.enableSound}
                </button>
              ) : null}
            </div>
            {blocked && i === toasts.length - 1 ? (
              <p className="mt-1 text-[11px] text-text-secondary">{t.soundBlocked}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => dismiss(x.id)}
            aria-label={dict.app.common.close}
            className="p-1 rounded text-text-secondary hover:bg-bg-main"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
