"use client";

// Shared barcode / QR / SKU scanner modal. Used by the inventory add/edit
// flow (to fill the SKU field) and by the POS (to look up a product).
//
// The decoder (`@yudiel/react-qr-scanner`, which wraps the BarcodeDetector
// API + a ZXing-wasm polyfill) is dynamically imported so it never lands
// in the initial bundle — it only loads when the user actually opens the
// scanner.
//
// MVP behaviour: single-scan mode. We fire `onDetected` with the first
// raw value we see, then the caller closes the modal. Continuous scanning
// is intentionally out of scope.
//
// `onDetected` takes a raw string — the caller decides what it means
// (barcode, internal SKU, future QR payload, etc.). Keeps the abstraction
// reusable.

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Barcode, CameraSlash } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { playBeep } from "@/lib/scanner/beep";
import type { IDetectedBarcode, IScannerError, ScannerErrorKind } from "@yudiel/react-qr-scanner";

const Scanner = dynamic(
  () => import("@yudiel/react-qr-scanner").then((m) => m.Scanner),
  { ssr: false, loading: () => <ScannerSkeleton /> },
);

function ScannerSkeleton() {
  const dict = useDictionary();
  const t = dict.app.ui.scanner;
  return (
    <div className="aspect-square w-full bg-black/90 rounded-xl flex items-center justify-center text-white text-sm">
      {t.loading}
    </div>
  );
}

export interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Fires once with the first decoded value. Caller closes the modal. */
  onDetected: (code: string) => void;
  /** Override the default title (e.g. "Scan product barcode"). */
  title?: string;
}

type DisplayErrorKey =
  | "permissionDenied"
  | "httpsRequired"
  | "notSupported"
  | "genericError";

function mapErrorToKey(kind: ScannerErrorKind): DisplayErrorKey {
  switch (kind) {
    case "permission-denied":
    case "security":
      return "permissionDenied";
    case "insecure-context":
      return "httpsRequired";
    case "no-camera":
    case "unsupported":
      return "notSupported";
    default:
      return "genericError";
  }
}

export function BarcodeScannerModal({
  isOpen,
  onClose,
  onDetected,
  title,
}: BarcodeScannerModalProps) {
  const dict = useDictionary();
  const t = dict.app.ui.scanner;

  // ScannerBody is mounted only while `isOpen` is true. That gives us
  // fresh state on every open without an effect-driven reset, and tears
  // down the camera + WASM polyfill the moment the modal closes.
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title ?? t.title}>
      {isOpen ? (
        <ScannerBody onDetected={onDetected} onClose={onClose} />
      ) : null}
    </Modal>
  );
}

function ScannerBody({
  onDetected,
  onClose,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const dict = useDictionary();
  const t = dict.app.ui.scanner;

  // Detection guard: in single-scan mode we want to fire onDetected once
  // even though the decoder may emit consecutive frames before React tears
  // down the modal.
  const firedRef = useRef(false);
  const [errorKey, setErrorKey] = useState<DisplayErrorKey | null>(null);
  const [manual, setManual] = useState("");

  const handleScan = (detected: IDetectedBarcode[]) => {
    if (firedRef.current) return;
    const value = detected[0]?.rawValue?.trim();
    if (!value) return;
    firedRef.current = true;
    // Beep — primed by the Scan button's onClick inside the user-gesture
    // window. See lib/scanner/beep.ts for why this matters on iOS.
    playBeep();
    // Haptic feedback on supported devices (Android Chrome). Silently
    // no-ops where unsupported (iOS doesn't expose navigator.vibrate).
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(60);
      } catch {
        // Some browsers throw without a user gesture chain — harmless.
      }
    }
    onDetected(value);
  };

  const handleError = (err: IScannerError) => {
    setErrorKey(mapErrorToKey(err.kind));
  };

  const handleManualSubmit = () => {
    const value = manual.trim();
    if (!value || firedRef.current) return;
    firedRef.current = true;
    onDetected(value);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary flex items-center gap-2">
        <Barcode className="w-4 h-4 shrink-0" />
        <span>{t.subtitle}</span>
      </p>

      {errorKey ? (
        <div className="rounded-xl bg-danger-light/40 border border-danger/30 p-4 flex items-start gap-3">
          <CameraSlash className="w-5 h-5 text-danger shrink-0 mt-0.5" />
          <p className="text-sm text-danger">{t[errorKey]}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-black">
          <Scanner
            onScan={handleScan}
            onError={handleError}
            constraints={{ facingMode: "environment" }}
            allowMultiple={false}
            // Sound is handled by our own primed audio element above —
            // the library's playback path doesn't survive iOS's
            // gesture-window check.
            sound={false}
            styles={{ container: { width: "100%" } }}
          />
        </div>
      )}

      <div className="space-y-2">
        <label className="block text-sm font-medium text-text-secondary">
          {t.manualLabel}
        </label>
        <div className="flex gap-2">
          <Input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder={t.manualPlaceholder}
            dir="ltr"
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleManualSubmit();
              }
            }}
          />
          <Button
            type="button"
            onClick={handleManualSubmit}
            disabled={!manual.trim()}
          >
            {t.manualSubmit}
          </Button>
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button variant="ghost" onClick={onClose}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}
