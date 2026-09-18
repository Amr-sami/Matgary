// ESC/POS control sequences — pure bytes, no platform imports (doc 06 §1.4).
//
// Every helper returns a Uint8Array so callers can `concat()` them into one
// buffer and hand that to any transport (BLE, TCP, a PDF stub in tests). The
// command set is the Epson TM-T88 core that Xprinter / GOOJPRT / clones all
// honour; anything vendor-specific is deliberately absent.

export const ESC = 0x1b;
export const GS = 0x1d;
export const LF = 0x0a;

export type Align = "left" | "center" | "right";

/** Join byte chunks into one buffer. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const b = (...bytes: number[]) => Uint8Array.from(bytes);

/** ESC @ — reset the printer to power-on defaults. Always the first command. */
export const init = (): Uint8Array => b(ESC, 0x40);

/** LF — print the buffered line and feed one line. */
export const newline = (): Uint8Array => b(LF);

/** ESC d n — feed n lines (0–255). */
export const feed = (lines = 1): Uint8Array => b(ESC, 0x64, clampByte(lines));

/** ESC a n — justification for everything that follows. */
export const align = (a: Align): Uint8Array => b(ESC, 0x61, a === "center" ? 1 : a === "right" ? 2 : 0);

/** ESC E n — emphasised (bold) on/off. */
export const bold = (on: boolean): Uint8Array => b(ESC, 0x45, on ? 1 : 0);

/** ESC - n — underline off / 1-dot / 2-dot. */
export const underline = (mode: 0 | 1 | 2): Uint8Array => b(ESC, 0x2d, mode);

/** ESC { n — upside-down printing (some shops mount the printer facing away). */
export const invert = (on: boolean): Uint8Array => b(ESC, 0x7b, on ? 1 : 0);

/**
 * GS ! n — character size. Width and height multipliers are 1–8; the byte packs
 * (width-1) in the high nibble and (height-1) in the low nibble.
 */
export function size(width: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, height: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = width): Uint8Array {
  return b(GS, 0x21, ((width - 1) << 4) | (height - 1));
}

/** ESC M n — font A (12×24, 48 cols on 80mm) or font B (9×17, 64 cols). */
export const font = (which: "A" | "B"): Uint8Array => b(ESC, 0x4d, which === "B" ? 1 : 0);

/**
 * ESC t n — select the character code table. The numbers are Epson's. Not
 * every clone follows them: Xprinter / GOOJPRT firmware numbers the same
 * tables differently (see CODEPAGE_XPRINTER), so the numbering is a
 * per-printer choice the shop confirms with a test print.
 */
export const CODEPAGE = {
  /** PC437 — US ASCII + box drawing. Power-on default on almost every printer. */
  pc437: 0,
  /** PC864 — IBM Arabic with pre-shaped presentation forms. */
  pc864: 37,
  /** WPC1256 — Windows Arabic, nominal (unshaped) letters only. */
  win1256: 50,
} as const;

export type CodepageName = keyof typeof CODEPAGE;

/** Which firmware's numbering ESC t uses for the tables above. */
export type CodeTableNumbering = "epson" | "xprinter";

/** The same tables as Xprinter's programming manual numbers them (XP-58 / PT-210 clones). */
export const CODEPAGE_XPRINTER: Record<CodepageName, number> = { pc437: 0, pc864: 22, win1256: 34 };

export const codepage = (page: CodepageName | number, numbering: CodeTableNumbering = "epson"): Uint8Array =>
  b(ESC, 0x74, typeof page === "number" ? clampByte(page) : (numbering === "xprinter" ? CODEPAGE_XPRINTER : CODEPAGE)[page]);

/** ESC R n — international character set; 0 = USA keeps `#`, `$`, `\` as ASCII. */
export const charsetUsa = (): Uint8Array => b(ESC, 0x52, 0);

/**
 * GS V m [n] — cut. Mode 66 (partial cut after feeding n) is the one the
 * cheap 80mm printers implement; 58mm printers without a cutter ignore it.
 */
export const cut = (partial = true, feedBefore = 3): Uint8Array =>
  partial ? b(GS, 0x56, 66, clampByte(feedBefore)) : b(GS, 0x56, 0);

/** ESC p m t1 t2 — kick a cash drawer on pin 2 (m=0) or pin 5 (m=1). */
export const drawerKick = (pin: 0 | 1 = 0): Uint8Array => b(ESC, 0x70, pin, 0x19, 0xfa);

/** DLE EOT n — real-time status request (1 = printer, 4 = paper). */
export const statusRequest = (n: 1 | 2 | 3 | 4 = 1): Uint8Array => b(0x10, 0x04, n);

/**
 * GS ( k — QR code in one call: model 2, module size `moduleSize` (1–16),
 * error correction L, then store and print the payload.
 */
export function qrCode(data: string, moduleSize = 4): Uint8Array {
  const payload = latin1Bytes(data);
  const storeLen = payload.length + 3;
  return concat(
    b(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 50, 0), // model 2
    b(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, clampByte(moduleSize)), // module size
    b(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 48), // EC level L
    b(GS, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30), // store
    payload,
    b(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30), // print
  );
}

/**
 * GS v 0 m xL xH yL yH d1…dk — print a raster bit image. `rows` is packed
 * 1 bit per pixel, MSB first, `bytesPerRow * height` long; 1 = black.
 * Callers with a wide image should chunk it with `rasterChunks()` — a single
 * GS v 0 taller than ~255 rows makes several clone firmwares drop bytes.
 */
export function rasterImage(rows: Uint8Array, bytesPerRow: number, height: number): Uint8Array {
  if (rows.length !== bytesPerRow * height) {
    throw new RangeError(`raster: expected ${bytesPerRow * height} bytes, got ${rows.length}`);
  }
  return concat(
    b(GS, 0x76, 0x30, 0, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff),
    rows,
  );
}

/** Bytes for a string that is already pure ASCII/Latin-1 — throws otherwise. */
export function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new RangeError(`latin1Bytes: U+${c.toString(16)} is not Latin-1`);
    out[i] = c;
  }
  return out;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
