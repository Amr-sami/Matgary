"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Clock,
  Check,
  XCircle,
  MapPin,
  AlertCircle,
} from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { Toast } from "@/components/ui/Toast";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatTime } from "@/lib/i18n/format";

type ToastT = { type: "success" | "error"; message: string };

interface LastEvent {
  id: string;
  type: "check_in" | "check_out";
  occurredAt: string;
  source: string;
}

/**
 * Compact attendance card mounted at the top of the staff dashboard.
 *
 * Hidden for the owner (they manage attendance through /team).
 * Visible to staff members regardless of permissions — but the manual button
 * is gated by `attendance_self_manual`. Geofence is always available if the
 * tenant has at least one configured location.
 */
export function SelfCheckIn() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.team.selfCheckIn;
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const isOwner = session?.user?.role === "owner";
  const allowManual = can(principal, "attendance_self_manual");

  const [last, setLast] = useState<LastEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"in" | "out" | null>(null);
  const [toast, setToast] = useState<ToastT | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch("/api/attendance/self/status", {
        cache: "no-store",
      });
      if (!res.ok) {
        setLast(null);
        return;
      }
      const json = await res.json();
      setLast(json.last ?? null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOwner && session?.user?.id) refresh();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, session?.user?.id]);

  if (isOwner || !session?.user?.id) return null;
  if (loading) return null;

  const isCheckedIn = last?.type === "check_in";
  const action: "check_in" | "check_out" = isCheckedIn ? "check_out" : "check_in";

  const submit = async (mode: "geofence" | "manual") => {
    setBusy(action === "check_in" ? "in" : "out");
    try {
      const payload: Record<string, unknown> = {
        type: action,
        source: mode,
      };
      if (mode === "geofence") {
        const coords = await getCoords();
        if (!coords) {
          setToast({
            type: "error",
            message: t.toast.geoFailed,
          });
          return;
        }
        payload.latitude = coords.latitude;
        payload.longitude = coords.longitude;
        payload.accuracyM = Math.round(coords.accuracy);
      }
      const res = await fetch("/api/attendance/self", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setToast({ type: "error", message: json.error || t.toast.saveFailed });
        return;
      }
      setToast({
        type: "success",
        message: action === "check_in" ? t.toast.checkedIn : t.toast.checkedOut,
      });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const lastTime = last ? formatTime(last.occurredAt, locale) : "";

  return (
    <>
      <div
        className={cn(
          "relative rounded-xl border p-4 sm:p-5 flex flex-col sm:flex-row items-stretch sm:items-center gap-4",
          isCheckedIn
            ? "bg-success/5 border-success/30"
            : "bg-bg-card border-border",
        )}
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span
            className={cn(
              "shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-xl",
              isCheckedIn
                ? "bg-success/15 text-success"
                : "bg-accent-light text-accent",
            )}
          >
            <Clock className="w-5 h-5" weight="bold" />
          </span>
          <div className="min-w-0">
            <p className="font-bold text-text-primary text-sm sm:text-base">
              {isCheckedIn ? t.checkedIn : t.checkInTitle}
            </p>
            <p className="text-xs text-text-secondary mt-0.5">
              {isCheckedIn
                ? t.sinceLabel.replace("{time}", lastTime)
                : last
                  ? t.lastCheckoutLabel.replace("{time}", lastTime)
                  : t.notYetToday}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap sm:flex-nowrap">
          <Button
            onClick={() => submit("geofence")}
            loading={busy !== null}
            disabled={busy !== null}
            variant={isCheckedIn ? "secondary" : "primary"}
            className="gap-1.5"
          >
            {isCheckedIn ? (
              <XCircle className="w-4 h-4" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            <span>
              {isCheckedIn ? t.checkOut : t.checkIn}
            </span>
            <MapPin className="w-3.5 h-3.5 opacity-80" />
          </Button>
          {allowManual && (
            <button
              type="button"
              onClick={() => submit("manual")}
              disabled={busy !== null}
              className="text-xs font-medium text-text-secondary hover:text-accent disabled:opacity-50 px-2 py-2"
            >
              {t.manualButton}
            </button>
          )}
        </div>

        {!allowManual && (
          <span className="absolute top-2 end-2 text-[10px] text-text-secondary inline-flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {t.needsLocation}
          </span>
        )}
      </div>
      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}

function getCoords(): Promise<GeolocationCoordinates | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
}
