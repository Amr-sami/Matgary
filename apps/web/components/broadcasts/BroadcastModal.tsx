"use client";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { AlertCircle, X } from "@/lib/icons";

interface Broadcast {
  id: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string | null;
  bodyEn: string | null;
  severity: "critical";
}

interface Props {
  broadcast: Broadcast | null;
  locale: "ar" | "en";
  onClose: () => void;
}

/** Center-screen popup for the most recent un-acknowledged critical broadcast.
 *  Dismissing it doesn't fully hide the broadcast — it just turns into a
 *  banner at the top via BroadcastStack. That way the user can't accidentally
 *  miss it: they have to interact with the modal, but they aren't pestered
 *  on every page after they've seen it. */
export function BroadcastModal({ broadcast, locale, onClose }: Props) {
  const dict = useDictionary();
  const t = dict.app.broadcastModal;
  if (!broadcast) return null;
  const title = locale === "ar" ? broadcast.titleAr : broadcast.titleEn;
  const body = locale === "ar" ? broadcast.bodyAr : broadcast.bodyEn;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={title}
      hideHeader
      className="max-w-md overflow-hidden broadcast-glow"
    >
      {/* Thin danger rail at the very top — the only saturated colour on
          the surface. Reads as "this is a system alert" without making
          the whole header look like a marketing ribbon. */}
      <div aria-hidden className="h-[3px] bg-danger" />

      {/* Header: white surface, red icon + uppercase meta label, neutral
          title. Matches the calmer banner aesthetic. */}
      <div className="relative px-5 pt-5 pb-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق"
          className="absolute top-4 end-4 w-7 h-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-main transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-start gap-3 pe-8">
          <AlertCircle className="w-5 h-5 mt-1 shrink-0 text-danger broadcast-critical-pulse rounded-full" />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-danger">
              {t.severityLabel}
            </p>
            <h2
              className="text-lg font-semibold text-text-primary leading-snug mt-1 break-words"
              dir="auto"
            >
              {title}
            </h2>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="px-5 pb-5">
        {body && (
          <p
            className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap mt-1"
            dir="auto"
          >
            {body}
          </p>
        )}
        <div className="flex justify-end mt-5">
          <Button variant="danger" onClick={onClose}>
            {t.gotIt}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
