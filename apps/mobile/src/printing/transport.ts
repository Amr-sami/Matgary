// The seam between "bytes for a printer" and "how they get there" (doc 06 §1.4).
//
// packages/domain/escpos produces Uint8Arrays; a PrinterTransport moves them.
// BLE is the only transport wired today (iOS + Android); "pdf" is the name
// reserved for the expo-print path that lives in receipt/share.ts, so the
// registry can one day list both kinds side by side.

export type TransportKind = "ble" | "pdf";

export interface PrinterTransport {
  id: string;
  name: string;
  kind: TransportKind;
  connect(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
}

/** What went wrong, in terms the settings screen can translate. */
export type PrinterErrorCode =
  | "unsupported" // no BLE radio (simulator) or the native module is missing
  | "poweredOff"
  | "unauthorized"
  | "notFound" // scan finished without seeing the saved printer
  | "noWritableCharacteristic"
  | "disconnected"
  | "timeout"
  | "tooLong" // raster: the ticket does not fit the bitmap height cap
  | "unknown";

export class PrinterError extends Error {
  constructor(
    public readonly code: PrinterErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PrinterError";
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Uint8Array → base64 (ble-plx takes payloads as base64 strings). */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? B64[n & 63]! : "=";
  }
  return out;
}

/** base64 → Uint8Array (the WebView rasterizer posts its bitmap this way). */
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]!) << 18) |
      (B64.indexOf(clean[i + 1] ?? "A") << 12) |
      (B64.indexOf(clean[i + 2] ?? "A") << 6) |
      B64.indexOf(clean[i + 3] ?? "A");
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reject after `ms` — BLE promises can hang forever on a printer that walked away. */
export function withTimeout<T>(p: Promise<T>, ms: number, code: PrinterErrorCode = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PrinterError(code)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
