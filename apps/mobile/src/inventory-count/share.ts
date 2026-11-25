/**
 * Share the backend-authoritative inventory-count PDF.
 *
 * Unlike receipts / customer statements (which render HTML with expo-print
 * on-device), the inventory-count PDF comes from the server so the numbers
 * are byte-for-byte the ones persisted in `inventory_count_reconciliations`.
 * The owner can trust the PDF to match the DB — no risk of a client-side
 * recomputation drifting from what confirm wrote.
 *
 * Flow:
 *   1. GET /api/inventory-counts/<id>/report.pdf with the bearer token.
 *   2. Write the Uint8Array to a cache file under the server-chosen name.
 *   3. Open the native share sheet (expo-sharing). The OS lets the user pick
 *      WhatsApp / Telegram / Mail / AirDrop / Files — no app-specific wiring.
 */

import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { api, API_BASE_URL } from "@/api/client";
import { getLocale } from "@/i18n";

export class InventoryCountShareUnavailableError extends Error {
  constructor() {
    super("sharing unavailable");
    this.name = "InventoryCountShareUnavailableError";
  }
}

export class InventoryCountShareFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "InventoryCountShareFetchError";
    this.status = status;
  }
}

export interface ShareInventoryCountInput {
  countId: string;
  /** Pre-fetched filename (from the report JSON) — keeps the PDF's share-sheet
   *  title consistent with the file the server generated. */
  filename: string;
}

export async function shareInventoryCountPdf(
  input: ShareInventoryCountInput,
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new InventoryCountShareUnavailableError();
  }

  const tokens = await api.currentTokens();
  const locale = getLocale();
  const url = `${API_BASE_URL}/api/inventory-counts/${encodeURIComponent(input.countId)}/report.pdf?locale=${encodeURIComponent(locale)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: tokens
      ? { Authorization: `Bearer ${tokens.accessToken}` }
      : undefined,
  });

  if (!res.ok) {
    throw new InventoryCountShareFetchError(
      res.status,
      `pdf fetch failed (${res.status})`,
    );
  }

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const dest = new File(Paths.cache, input.filename);
  if (dest.exists) dest.delete();
  dest.create();
  dest.write(bytes);

  await Sharing.shareAsync(dest.uri, {
    mimeType: "application/pdf",
    UTI: "com.adobe.pdf",
    dialogTitle: input.filename,
  });
}
