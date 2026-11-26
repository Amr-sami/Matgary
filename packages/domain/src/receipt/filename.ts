// Professional receipt filename.
//
// Used by both web (apps/web/app/api/whatsapp/send-pdf/route.ts,
// apps/web/lib/whatsapp/outbound.ts) and mobile (apps/mobile/src/receipt/share.ts)
// so WhatsApp / Mail / Files land a receipt named after the transaction instead
// of a random tmp path or an opaque "receipt-XXXXX".
//
// Shape: `Invoice-YYYY-MM-DD-{reference}.pdf` where {reference} is
//   - the Owner's `receiptReferencePrefix` + the last 10 chars of invoiceId,
//     when a prefix is configured (e.g. "INV-A1B2C3D4E5"); or
//   - the 10-char short code alone, when no prefix is set.
//
// Pure — no Intl, no I/O. Keep it that way; this is called from edge routes
// and React Native alike.

export interface ReceiptFilenameInput {
  invoiceId: string;
  /** Sale date; ISO string or Date — the filename uses the calendar date. */
  saleDate: string | Date;
  /** Max 8 chars of [A-Z0-9-]. Empty string / undefined = plain short code. */
  referencePrefix?: string | null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/** Last 10 chars of the invoice id, upper-cased. Matches `receiptCode()` in
 *  apps/mobile/src/receipt/html.ts and the web's InvoiceReceipt shortCode. */
export function receiptShortCode(invoiceId: string): string {
  return invoiceId.slice(-10).toUpperCase();
}

/** `{prefix}-{short}` when prefix present; otherwise `{short}`. */
export function receiptReference(
  invoiceId: string,
  referencePrefix?: string | null,
): string {
  const short = receiptShortCode(invoiceId);
  const prefix = (referencePrefix ?? "").replace(/[^A-Za-z0-9-]/g, "").toUpperCase().slice(0, 8);
  return prefix ? `${prefix}-${short}` : short;
}

/** `Invoice-YYYY-MM-DD-{reference}.pdf`. Safe for iOS / Android / Linux FS. */
export function receiptFilename(input: ReceiptFilenameInput): string {
  const d = toDate(input.saleDate);
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `Invoice-${y}-${m}-${day}-${receiptReference(input.invoiceId, input.referencePrefix)}.pdf`;
}
