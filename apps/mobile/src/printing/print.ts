// One entry point: a saved printer + a ticket → paper.

import {
  type Bitmap1,
  type PaperWidth,
  type Ticket,
  align,
  concat,
  cut,
  feed,
  newline,
  qrCode,
  receiptToRasterCommands,
  textReceipt,
} from "@matgary/domain";

import { createBleTransport } from "./ble";
import { type SavedPrinter, updatePrinter } from "./registry";
import { PrinterError } from "./transport";

export type Rasterize = (ticket: Ticket, width: PaperWidth) => Promise<Bitmap1>;

/**
 * Bytes for a ticket in the printer's configured mode. Raster mode draws
 * text/row/rule/feed as a bitmap and appends QR / feed / cut as native
 * commands (the printer's own QR module is crisper than any bitmap).
 */
export async function ticketBytes(ticket: Ticket, printer: SavedPrinter, rasterize?: Rasterize): Promise<Uint8Array> {
  if (printer.mode === "raster" && rasterize) {
    const bitmap = await rasterize(ticket, printer.width);
    const tail: Uint8Array[] = [];
    let cutAt = false;
    for (const l of ticket.lines) {
      if (l.kind === "qr") tail.push(align("center"), qrCode(l.data, printer.width === 58 ? 4 : 6), newline());
      else if (l.kind === "cut") cutAt = true;
    }
    // trailing feed lines were drawn as whitespace in the bitmap already
    return concat(receiptToRasterCommands(bitmap, { cut: false, feedAfter: 1 }), ...tail, feed(2), cutAt ? cut(true, 1) : new Uint8Array());
  }
  return textReceipt(ticket, { width: printer.width, numbering: printer.codeTable });
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Connect, send, disconnect. Serialised — two taps never interleave chunks
 * on the same characteristic. A stale remembered characteristic is dropped
 * so the next attempt rediscovers.
 */
export function printTicket(printer: SavedPrinter, ticket: Ticket, rasterize?: Rasterize): Promise<void> {
  const run = async () => {
    const bytes = await ticketBytes(ticket, printer, rasterize);
    if (printer.kind !== "ble") throw new PrinterError("unsupported");
    const transport = createBleTransport({
      id: printer.id,
      name: printer.name,
      serviceUUID: printer.serviceUUID,
      characteristicUUID: printer.characteristicUUID,
      writeWithResponse: printer.writeWithResponse,
      onCharacteristicFound: (serviceUUID, characteristicUUID, writeWithResponse) =>
        updatePrinter(printer.id, { serviceUUID, characteristicUUID, writeWithResponse }),
    });
    try {
      await transport.connect();
      await transport.write(bytes);
    } catch (e) {
      if (e instanceof PrinterError && (e.code === "disconnected" || e.code === "noWritableCharacteristic") && printer.characteristicUUID) {
        updatePrinter(printer.id, { serviceUUID: undefined, characteristicUUID: undefined, writeWithResponse: undefined });
      }
      throw e;
    } finally {
      await transport.disconnect();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** i18n key for a printer failure — the screens render t(printerErrorKey(e)). */
export function printerErrorKey(e: unknown): string {
  const code = e instanceof PrinterError ? e.code : "unknown";
  switch (code) {
    case "unsupported":
      return "mobile.printing.errUnsupported";
    case "poweredOff":
      return "mobile.printing.errPoweredOff";
    case "unauthorized":
      return "mobile.printing.errUnauthorized";
    case "notFound":
      return "mobile.printing.errNotFound";
    case "noWritableCharacteristic":
      return "mobile.printing.errNoCharacteristic";
    case "disconnected":
      return "mobile.printing.errDisconnected";
    case "timeout":
      return "mobile.printing.errTimeout";
    case "tooLong":
      return "mobile.printing.errTooLong";
    default:
      return "mobile.printing.errUnknown";
  }
}
