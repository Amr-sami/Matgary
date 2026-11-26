"use client";

import { useMemo } from "react";
import { isValidIpaLink } from "@matgary/domain/collections/ipa";
import { qrMatrix, qrSvgPath } from "@matgary/domain/collections/qr";

/**
 * The POS QR of an InstaPay payment link (doc 15 spec 12 §4.10, 06 §4.7):
 * black modules on a white quiet zone of 4 — also in dark mode — so a phone
 * camera reads it. A link that fails `isValidIpaLink` is never drawn (the
 * look-alike phishing risk IF7). Whether the InstaPay app accepts a QR of the
 * plain link is UNVERIFIED (I3, 12 R5).
 */
export function IpaQr({
  link,
  size = 200,
  label,
  testId,
}: {
  link: string;
  size?: number;
  /** aria-label (the scan hint). */
  label?: string;
  testId?: string;
}) {
  const valid = isValidIpaLink(link);
  const qr = useMemo(() => {
    if (!valid) return null;
    try {
      return qrSvgPath(qrMatrix(link.trim()), 4);
    } catch {
      return null;
    }
  }, [link, valid]);
  if (!qr) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid={testId}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.viewBox} ${qr.viewBox}`}
      shapeRendering="crispEdges"
      className="rounded-lg border border-border bg-white"
    >
      <rect width={qr.viewBox} height={qr.viewBox} fill="#ffffff" />
      <path d={qr.d} fill="#000000" />
    </svg>
  );
}
