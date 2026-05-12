// Time-ago + window-countdown formatters for the inbox.

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.valueOf())) return "";
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "الآن";
  if (min < 60) return `قبل ${min} د`;
  const h = Math.round(min / 60);
  if (h < 24) return `قبل ${h} س`;
  const days = Math.round(h / 24);
  if (days < 7) return `قبل ${days} ي`;
  return d.toLocaleDateString("ar-EG", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.valueOf())) return "";
  return d.toLocaleTimeString("ar-EG", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Window state for the thread header. Returns a short Arabic label
 *  plus a tone hint so the caller can colour appropriately. */
export interface WindowDisplay {
  label: string;
  tone: "open" | "warning" | "closed";
}

export function windowDisplay(
  expiresAt: string | null | undefined,
): WindowDisplay {
  if (!expiresAt) {
    return {
      label: "العميل لم يراسل بعد — استخدم قالباً",
      tone: "closed",
    };
  }
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    return {
      label: "نافذة المحادثة مغلقة — استخدم قالباً",
      tone: "closed",
    };
  }
  const h = Math.round(ms / 3_600_000);
  if (h <= 1) {
    return {
      label: "النافذة تنتهي خلال ساعة — أرسل بسرعة",
      tone: "warning",
    };
  }
  return {
    label: `النافذة مفتوحة (${h} ساعة متبقية)`,
    tone: "open",
  };
}
