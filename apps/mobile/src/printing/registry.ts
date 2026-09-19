// Saved printers — MMKV, synchronous, per device (doc 06 §1.4 "printer
// registry persisted in MMKV"). A shop's counter pairs its printer once;
// every sale after that prints without a scan.

import { useSyncExternalStore } from "react";
import { createMMKV } from "react-native-mmkv";

import type { CodeTableNumbering, PaperWidth } from "@matgary/domain";

import type { TransportKind } from "./transport";

/** How Arabic reaches the paper — see packages/domain/src/escpos/receipt.ts. */
export type PrintMode = "raster" | "text";

export interface SavedPrinter {
  /** BLE peripheral identifier (a UUID on iOS, a MAC on Android). */
  id: string;
  name: string;
  kind: TransportKind;
  width: PaperWidth;
  isDefault: boolean;
  mode: PrintMode;
  /**
   * Text mode only: whose ESC t numbering the firmware uses for the Arabic
   * code table (Epson 37 vs Xprinter 22). Unset = Epson. The shop flips it
   * when a test print in printer-font mode comes out as garbage.
   */
  codeTable?: CodeTableNumbering;
  /** The characteristic that accepted bytes last time — skips discovery. */
  serviceUUID?: string;
  characteristicUUID?: string;
  /** With-response writes are slower but some printers only honour those. */
  writeWithResponse?: boolean;
}

const store = createMMKV({ id: "printers" });
const KEY = "saved";
const listeners = new Set<() => void>();
let cache: SavedPrinter[] | null = null;

function read(): SavedPrinter[] {
  if (cache) return cache;
  try {
    const raw = store.getString(KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedPrinter[]) : [];
    cache = Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.id === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: SavedPrinter[]): void {
  cache = next;
  try {
    store.set(KEY, JSON.stringify(next));
  } catch {
    // MMKV write failures are not worth blocking a print over — the in-memory
    // list still drives this session.
  }
  listeners.forEach((l) => l());
}

export function listPrinters(): SavedPrinter[] {
  return read();
}

export function getPrinter(id: string): SavedPrinter | undefined {
  return read().find((p) => p.id === id);
}

export function getDefaultPrinter(): SavedPrinter | undefined {
  const all = read();
  return all.find((p) => p.isDefault) ?? all[0];
}

/** Add or update; the first printer ever saved becomes the default. */
export function savePrinter(input: Omit<SavedPrinter, "isDefault" | "mode" | "width"> & Partial<Pick<SavedPrinter, "isDefault" | "mode" | "width">>): SavedPrinter {
  const all = read();
  const existing = all.find((p) => p.id === input.id);
  const next: SavedPrinter = {
    width: 58,
    mode: "raster",
    isDefault: all.length === 0,
    ...existing,
    ...input,
  };
  const rest = all.filter((p) => p.id !== input.id);
  write(next.isDefault ? [next, ...rest.map((p) => ({ ...p, isDefault: false }))] : [...rest, next]);
  return next;
}

export function updatePrinter(id: string, patch: Partial<Omit<SavedPrinter, "id">>): void {
  write(read().map((p) => (p.id === id ? { ...p, ...patch } : p)));
}

export function setDefaultPrinter(id: string): void {
  write(read().map((p) => ({ ...p, isDefault: p.id === id })));
}

export function removePrinter(id: string): void {
  const rest = read().filter((p) => p.id !== id);
  if (rest.length && !rest.some((p) => p.isDefault)) rest[0]!.isDefault = true;
  write(rest);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Live list for React — re-renders on every registry change. */
export function usePrinters(): SavedPrinter[] {
  return useSyncExternalStore(subscribe, read, read);
}

export function useDefaultPrinter(): SavedPrinter | undefined {
  const all = usePrinters();
  return all.find((p) => p.isDefault) ?? all[0];
}
