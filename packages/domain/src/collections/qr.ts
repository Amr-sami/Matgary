// Digital collections — the POS QR for an InstaPay link (spec 06 §4.7).
//
// `qrcode` is pure JS: Metro takes its `browser` entry (lib/browser.js), Node
// and Next take lib/server.js; both reach the same lib/core/qrcode.js, which
// uses only Uint8Array and TextEncoder. The mobile POS draws the path with
// react-native-svg (already in the binary) and the web POS with an inline
// <svg>, so both screens show an identical QR and no native change is needed.
//
// Whether the InstaPay app's own QR encodes exactly the stored link is
// UNVERIFIED (I3); if it carries more, only the text passed in here changes.
//
// This file is NOT re-exported from the package root (src/index.ts), so
// `import "@matgary/domain"` never loads `qrcode`. Import the subpath
// `@matgary/domain/collections/qr`.
//
// Hermes-safe.

import { create } from "qrcode";

export interface QrMatrix {
  /** Modules per side (21 + 4 × (version − 1)). */
  size: number;
  version: number;
  /** Row-major size × size; 1 = dark. A copy, owned by the caller. */
  modules: Uint8Array;
}

/**
 * The module matrix of `text` at error-correction level `ecc` (default "M").
 * Throws RangeError for empty text and for text over the QR capacity.
 */
export function qrMatrix(text: string, opts?: { ecc?: "L" | "M" | "Q" | "H" }): QrMatrix {
  if (typeof text !== "string" || text.length === 0) throw new RangeError("qrMatrix: text is empty");
  const ecc = opts?.ecc ?? "M";
  let qr: ReturnType<typeof create>;
  try {
    qr = create(text, { errorCorrectionLevel: ecc });
  } catch (e) {
    throw new RangeError(`qrMatrix: cannot encode text (${e instanceof Error ? e.message : String(e)})`);
  }
  const size = qr.modules.size;
  const modules = Uint8Array.from(qr.modules.data, (v) => (v ? 1 : 0));
  return { size, version: qr.version, modules };
}

/**
 * One SVG path covering every dark module, as horizontal runs
 * "M{x} {y}h{n}v1h-{n}z", offset by a `quiet` zone of light modules on each
 * side. Render with viewBox `0 0 {viewBox} {viewBox}` (viewBox = size + 2 ×
 * quiet) and a fill colour; no stroke.
 */
export function qrSvgPath(m: QrMatrix, quiet = 4): { d: string; viewBox: number } {
  if (!Number.isInteger(quiet) || quiet < 0) throw new RangeError("qrSvgPath: quiet must be a non-negative integer");
  const { size, modules } = m;
  const parts: string[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (modules[y * size + x]) {
        let n = 1;
        while (x + n < size && modules[y * size + x + n]) n++;
        parts.push(`M${x + quiet} ${y + quiet}h${n}v1h-${n}z`);
        x += n;
      } else {
        x++;
      }
    }
  }
  return { d: parts.join(""), viewBox: size + 2 * quiet };
}
