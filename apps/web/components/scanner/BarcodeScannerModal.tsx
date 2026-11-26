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

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Barcode, CameraSlash } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { playBeep } from "@/lib/scanner/beep";
import {
  getScanReport,
  isScanPerfEnabled,
  markScan,
  subscribeScanPerf,
} from "@/lib/scanner/perf";
import type { IDetectedBarcode, IScannerError, ScannerErrorKind } from "@yudiel/react-qr-scanner";

const Scanner = dynamic(
  () =>
    import("@yudiel/react-qr-scanner").then((m) => {
      markScan("decoder");
      return m.Scanner;
    }),
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [errorKey, setErrorKey] = useState<DisplayErrorKey | null>(null);
  const [manual, setManual] = useState("");

  // Mark "modal" the instant ScannerBody mounts (which is synchronous
  // with the click that opened the modal, modulo one React commit).
  useEffect(() => {
    markScan("modal");
  }, []);

  // Mark "firstFrame" when the decoder library's <video> element starts
  // playing. The library inserts the <video> inside our container; we
  // watch it via MutationObserver because Scanner is a black-box dynamic
  // import we can't ref directly.
  useEffect(() => {
    if (!containerRef.current) return;
    const root = containerRef.current;
    let video: HTMLVideoElement | null = null;
    const onPlaying = () => {
      markScan("firstFrame");
      video?.removeEventListener("playing", onPlaying);
    };
    const observer = new MutationObserver(() => {
      const v = root.querySelector("video");
      if (v && v !== video) {
        video = v;
        if (!v.paused && v.readyState >= 2) {
          onPlaying();
        } else {
          v.addEventListener("playing", onPlaying);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      video?.removeEventListener("playing", onPlaying);
    };
  }, []);

  const handleScan = (detected: IDetectedBarcode[]) => {
    if (firedRef.current) return;
    const value = detected[0]?.rawValue?.trim();
    if (!value) return;
    firedRef.current = true;
    markScan("firstScan");
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
        <div ref={containerRef} className="overflow-hidden rounded-xl bg-black">
          <Scanner
            onScan={handleScan}
            onError={handleError}
            constraints={{ facingMode: "environment" }}
            allowMultiple={false}
            // Sound is handled by our own primed audio element above —
            // the library's playback path doesn't survive iOS's
            // gesture-window check.
            sound={false}
            // Library default is 500 ms — used to read torch/zoom
            // capabilities we don't surface. Drop to 0 so the decoder
            // can start scanning the moment the camera plays.
            settleDelayMs={0}
            // Library default is 100 ms between detection attempts.
            // 33 ms ≈ one frame at 30 fps — gives the camera every
            // frame to decode instead of skipping ~70% of them.
            retryDelay={33}
            styles={{ container: { width: "100%" } }}
          />
        </div>
      )}

      <ScanPerfOverlay />


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

// On-screen perf readout — visible only when the URL has `?perf=1`.
// Lives inside the scanner modal so the cashier doesn't see it during
// normal use. Numbers are deltas (ms) from the click that opened the
// modal: click → modal → decoder → firstFrame → firstScan.
function ScanPerfOverlay() {
  const [report, setReport] = useState(() => getScanReport());
  const enabled = isScanPerfEnabled();
  useEffect(() => {
    if (!enabled) return;
    return subscribeScanPerf(() => setReport(getScanReport()));
  }, [enabled]);
  if (!enabled) return null;
  const rows: Array<[string, number | undefined]> = [
    ["click", report.deltas.click],
    ["modal", report.deltas.modal],
    ["decoder", report.deltas.decoder],
    ["firstFrame", report.deltas.firstFrame],
    ["firstScan", report.deltas.firstScan],
  ];
  return (
    <div
      dir="ltr"
      className="rounded-lg bg-black/80 text-white text-xs font-mono p-3 space-y-0.5"
    >
      <p className="text-[10px] uppercase tracking-wider text-white/60 mb-1">
        scan perf (ms from click)
      </p>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4">
          <span className="text-white/80">{k}</span>
          <span className="tabular-nums">{v == null ? "—" : `+${v}`}</span>
        </div>
      ))}
    </div>
  );
}
