"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Wallet } from "@/lib/icons";
import { useCashShift } from "@/hooks/useCashShift";
import { CashDrawerPanel } from "./CashDrawerPanel";
import { OpenShiftModal } from "./OpenShiftModal";
import { Toast } from "@/components/ui/Toast";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

// Self-hides when the signed-in user has no permission to open/close a
// shift (e.g. read-only managers, view-only roles). Visible to owners
// (implicit grant) and any staff with `open_close_shift`.
export function CashDrawerChip() {
  const { data: session } = useSession();
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.cashShifts.chip;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";
  const perms = session?.user?.permissions ?? [];
  const role = session?.user?.role ?? null;
  const canOpen = role === "owner" || perms.includes("open_close_shift");

  const { shift, refresh } = useCashShift();
  const [panelOpen, setPanelOpen] = useState(false);
  const [openShiftOpen, setOpenShiftOpen] = useState(false);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);

  if (!canOpen) return null;

  if (!shift) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpenShiftOpen(true)}
          className="hidden md:inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-bg-card border border-dashed border-border text-xs font-medium text-text-secondary hover:border-accent hover:text-accent transition-colors"
          title={t.openTitle}
        >
          <Wallet className="w-4 h-4" />
          <span>{t.openCta}</span>
        </button>
        <OpenShiftModal
          isOpen={openShiftOpen}
          onClose={() => setOpenShiftOpen(false)}
          onOpened={async () => {
            await refresh();
            setToast({ type: "success", message: t.openedToast });
          }}
          onError={(m) => setToast({ type: "error", message: m })}
        />
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

  const expected = shift.expectedCash ? Number(shift.expectedCash) : null;
  const openedTime = new Date(shift.openedAt).toLocaleTimeString(dateLocale);
  return (
    <>
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        className="hidden md:inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-accent-light border border-transparent text-xs font-semibold text-accent hover:bg-accent hover:text-white transition-colors"
        title={t.openedAt.replace("{time}", openedTime)}
      >
        <Wallet className="w-4 h-4" />
        <span dir="ltr">
          ₤
          {expected != null
            ? expected.toLocaleString("en-US", { maximumFractionDigits: 0 })
            : "—"}
        </span>
      </button>
      <CashDrawerPanel
        isOpen={panelOpen}
        onClose={() => setPanelOpen(false)}
        onClosed={async () => {
          await refresh();
          setPanelOpen(false);
          setToast({ type: "success", message: t.closedToast });
        }}
        onError={(m) => setToast({ type: "error", message: m })}
      />
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
