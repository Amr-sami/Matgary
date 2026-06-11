"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { AlertCircle, AlertTriangle, Info, X } from "@/lib/icons";
import { BroadcastModal } from "./BroadcastModal";

type Severity = "info" | "warning" | "critical";

interface Broadcast {
  id: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string | null;
  bodyEn: string | null;
  severity: Severity;
}

const POLL_MS = 60_000; // refresh in line with the public cache TTL.

/** Two-layer broadcast surface mounted in AppShell:
 *
 *   - **Critical** broadcasts that haven't been acknowledged yet pop up as a
 *     center-screen modal. After the user dismisses the modal, the same
 *     broadcast becomes a regular banner at the top — they've seen it once,
 *     but the warning stays visible until they fully dismiss it.
 *
 *   - **Warning** + **info** broadcasts always render as banners (existing
 *     behavior; max 2 warnings + 2 info).
 *
 *   - **Full dismiss** removes the broadcast from both surfaces for that
 *     user × browser.
 *
 *  Two localStorage keys back the dismissal state:
 *    - `broadcast:dismissed:<userId>`        — fully dismissed (banner + modal)
 *    - `broadcast:modal-dismissed:<userId>`  — modal closed; banner still shown
 */
export function BroadcastStack() {
  const { data: session, status } = useSession();
  const dict = useDictionary();
  const locale = useLocale();
  const t = (dict.app.broadcastStack ?? { dismissAria: "Dismiss" }) as {
    dismissAria: string;
  };
  const userId = session?.user?.id ?? null;

  const [items, setItems] = useState<Broadcast[]>([]);
  const [dismissedFull, setDismissedFull] = useState<Set<string>>(new Set());
  const [dismissedModal, setDismissedModal] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!userId) return;
    try {
      const fullRaw = window.localStorage.getItem(`broadcast:dismissed:${userId}`);
      const modalRaw = window.localStorage.getItem(
        `broadcast:modal-dismissed:${userId}`,
      );
      setDismissedFull(new Set(fullRaw ? (JSON.parse(fullRaw) as string[]) : []));
      setDismissedModal(
        new Set(modalRaw ? (JSON.parse(modalRaw) as string[]) : []),
      );
    } catch {
      /* localStorage unavailable */
    }
  }, [userId]);

  const persistFullDismissed = useCallback(
    (next: Set<string>) => {
      if (!userId) return;
      try {
        window.localStorage.setItem(
          `broadcast:dismissed:${userId}`,
          JSON.stringify([...next]),
        );
      } catch {
        /* localStorage unavailable */
      }
    },
    [userId],
  );

  const persistModalDismissed = useCallback(
    (next: Set<string>) => {
      if (!userId) return;
      try {
        window.localStorage.setItem(
          `broadcast:modal-dismissed:${userId}`,
          JSON.stringify([...next]),
        );
      } catch {
        /* localStorage unavailable */
      }
    },
    [userId],
  );

  const dismissFully = useCallback(
    (id: string) => {
      setDismissedFull((prev) => {
        const next = new Set(prev);
        next.add(id);
        persistFullDismissed(next);
        return next;
      });
    },
    [persistFullDismissed],
  );

  const dismissModalOnly = useCallback(
    (id: string) => {
      setDismissedModal((prev) => {
        const next = new Set(prev);
        next.add(id);
        persistModalDismissed(next);
        return next;
      });
    },
    [persistModalDismissed],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/broadcasts", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { data: Broadcast[] };
      setItems(json.data);
    } catch {
      /* silent — surface is best-effort */
    }
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    load();
    const tid = setInterval(load, POLL_MS);
    return () => clearInterval(tid);
  }, [status, load]);

  // Bucket: a critical broadcast that hasn't been modal-dismissed yet goes
  // to the popup; everything else (modal-acknowledged criticals + warnings
  // + info) goes to the banner stack.
  const { modalCritical, bannerStack } = useMemo(() => {
    const visible = items.filter((b) => !dismissedFull.has(b.id));
    const pendingCritical = visible.find(
      (b) => b.severity === "critical" && !dismissedModal.has(b.id),
    );
    const remaining = pendingCritical
      ? visible.filter((b) => b !== pendingCritical)
      : visible;
    const critical = remaining
      .filter((b) => b.severity === "critical")
      .slice(0, 1);
    const warning = remaining.filter((b) => b.severity === "warning").slice(0, 2);
    const info = remaining.filter((b) => b.severity === "info").slice(0, 2);
    return {
      modalCritical: pendingCritical ?? null,
      bannerStack: [...critical, ...warning, ...info],
    };
  }, [items, dismissedFull, dismissedModal]);

  if (status !== "authenticated") return null;

  return (
    <>
      {bannerStack.length > 0 && (
        <div className="space-y-1.5">
          {bannerStack.map((b) => (
            <Banner
              key={b.id}
              b={b}
              locale={locale}
              dismissLabel={t.dismissAria}
              onDismiss={() => dismissFully(b.id)}
            />
          ))}
        </div>
      )}
      <BroadcastModal
        broadcast={
          modalCritical
            ? {
                id: modalCritical.id,
                titleAr: modalCritical.titleAr,
                titleEn: modalCritical.titleEn,
                bodyAr: modalCritical.bodyAr,
                bodyEn: modalCritical.bodyEn,
                severity: "critical",
              }
            : null
        }
        locale={locale}
        onClose={() => {
          if (modalCritical) dismissModalOnly(modalCritical.id);
        }}
      />
    </>
  );
}

function Banner({
  b,
  locale,
  dismissLabel,
  onDismiss,
}: {
  b: Broadcast;
  locale: "ar" | "en";
  dismissLabel: string;
  onDismiss: () => void;
}) {
  const tone = bannerTone(b.severity);
  const Icon = tone.Icon;
  const title = locale === "ar" ? b.titleAr : b.titleEn;
  const body = locale === "ar" ? b.bodyAr : b.bodyEn;
  return (
    <div
      role="status"
      aria-live={b.severity === "critical" ? "assertive" : "polite"}
      className="broadcast-banner broadcast-glow relative overflow-hidden rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.04),0_2px_8px_rgba(15,23,42,0.04)]"
    >
      {/* Severity accent rail on the leading edge — the only place color
          appears outside the icon. Reads as a system notice, not a coloured
          marketing block. */}
      <span
        aria-hidden
        className={`absolute start-0 top-0 bottom-0 w-[3px] ${tone.accentBar}`}
      />
      <div className="flex items-start gap-3 ps-4 pe-2 py-3">
        <Icon
          className={`w-[18px] h-[18px] shrink-0 mt-0.5 ${tone.iconColor} ${
            b.severity === "critical" ? "broadcast-critical-pulse rounded-full" : ""
          }`}
        />
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-semibold text-text-primary leading-snug"
            dir="auto"
          >
            {title}
          </p>
          {body && (
            <p
              className="text-[13px] text-text-secondary leading-relaxed mt-0.5"
              dir="auto"
            >
              {body}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="shrink-0 self-start w-7 h-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-main transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Per-severity palette. White surface across the board — color only
 *  on the leading-edge rail and the icon. Severity is signalled by the
 *  rail + icon, never by washing the whole banner in tint. Mirrors the
 *  notice patterns used by GitHub / Linear / Stripe. */
function bannerTone(severity: Severity): {
  Icon: typeof Info;
  accentBar: string;
  iconColor: string;
} {
  if (severity === "critical") {
    return {
      Icon: AlertCircle,
      accentBar: "bg-danger",
      iconColor: "text-danger",
    };
  }
  if (severity === "warning") {
    return {
      Icon: AlertTriangle,
      accentBar: "bg-amber-500",
      iconColor: "text-amber-600",
    };
  }
  return {
    Icon: Info,
    accentBar: "bg-slate-400",
    iconColor: "text-slate-500",
  };
}
