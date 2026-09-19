// BLE transport — react-native-ble-plx, iOS + Android (doc 06 §1.4 `ble.ts`).
//
// Bluetooth Classic SPP printers are NOT reachable from here: iOS has no
// public API for them and the doc's Android-only Kotlin module is a separate
// piece of work. This file covers the BLE printers (and the dual-mode ones
// that also expose a GATT write characteristic — most XP-58IIH / PT-210 do).

import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, type Device, State, type Subscription } from "react-native-ble-plx";

import { PrinterError, type PrinterTransport, sleep, toBase64, withTimeout } from "./transport";

// ---------------------------------------------------------------------------
// Manager singleton — constructing BleManager where the native module is
// missing throws; treat that exactly like a phone without a radio.

let manager: BleManager | null | undefined;

export function getBleManager(): BleManager | null {
  if (manager !== undefined) return manager;
  try {
    manager = new BleManager();
  } catch {
    manager = null;
  }
  return manager;
}

/** The states the settings screen renders. */
export type BleState = "unsupported" | "poweredOff" | "unauthorized" | "poweredOn" | "unknown";

function mapState(s: State): BleState {
  switch (s) {
    case State.PoweredOn:
      return "poweredOn";
    case State.PoweredOff:
      return "poweredOff";
    case State.Unauthorized:
      return "unauthorized";
    case State.Unsupported:
      return "unsupported";
    default:
      return "unknown";
  }
}

export async function getBleState(): Promise<BleState> {
  const m = getBleManager();
  if (!m) return "unsupported";
  try {
    return mapState(await withTimeout(m.state(), 3000));
  } catch {
    return "unknown";
  }
}

export function onBleStateChange(cb: (s: BleState) => void): () => void {
  const m = getBleManager();
  if (!m) {
    cb("unsupported");
    return () => {};
  }
  let sub: Subscription | null = null;
  try {
    sub = m.onStateChange((s) => cb(mapState(s)), true);
  } catch {
    cb("unknown");
  }
  return () => sub?.remove();
}

/** Android 12+ needs runtime BLUETOOTH_SCAN/CONNECT; older Android needs location for scans. */
export async function ensureAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const api = typeof Platform.Version === "number" ? Platform.Version : parseInt(String(Platform.Version), 10);
  try {
    if (api >= 31) {
      const res = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      return Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
    }
    const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    return res === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scanning

/** Services the common ESC/POS BLE printers advertise or expose. */
export const PRINTER_SERVICE_UUIDS = [
  "000018f0-0000-1000-8000-00805f9b34fb", // 0x18F0 — Xprinter / GOOJPRT / most clones (write char 0x2AF1)
  "0000ff00-0000-1000-8000-00805f9b34fb", // 0xFF00 — generic serial-over-GATT (write char 0xFF02)
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // "BlueTooth Printer" modules (write bef8d6c9-…)
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", // Microchip transparent UART (some POS-58 units)
  "0000ffe0-0000-1000-8000-00805f9b34fb", // HM-10 style UART (write char 0xFFE1)
];

const PREFERRED_WRITE: Record<string, string> = {
  "000018f0-0000-1000-8000-00805f9b34fb": "00002af1-0000-1000-8000-00805f9b34fb",
  "0000ff00-0000-1000-8000-00805f9b34fb": "0000ff02-0000-1000-8000-00805f9b34fb",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2": "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455": "49535343-8841-43f4-a8d4-ecbe34729bb3",
  "0000ffe0-0000-1000-8000-00805f9b34fb": "0000ffe1-0000-1000-8000-00805f9b34fb",
};

const norm = (u: string) => u.toLowerCase();
const PRINTER_NAME = /print|xp[- ]?\d|mtp|pos|goojprt|pt-?2|58|80|rpp|bt-?p|thermal|mpt/i;

export interface FoundDevice {
  id: string;
  name: string;
  rssi: number | null;
  /** Advertises a known printer service or carries a printer-looking name. */
  likelyPrinter: boolean;
}

/**
 * Scan for `durationMs` and report every NAMED device (printers always have
 * a name; nameless beacons are noise). Devices are de-duplicated by id and
 * the callback receives the whole list sorted: likely printers first, then
 * by signal strength.
 */
export async function scanForPrinters(durationMs: number, onUpdate: (devices: FoundDevice[]) => void): Promise<FoundDevice[]> {
  const m = getBleManager();
  if (!m) throw new PrinterError("unsupported");
  const state = await getBleState();
  if (state === "unsupported" || state === "poweredOff" || state === "unauthorized") throw new PrinterError(state);
  if (!(await ensureAndroidPermissions())) throw new PrinterError("unauthorized");

  const found = new Map<string, FoundDevice>();
  const emit = () =>
    onUpdate(
      [...found.values()].sort((a, b) => Number(b.likelyPrinter) - Number(a.likelyPrinter) || (b.rssi ?? -999) - (a.rssi ?? -999)),
    );

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      void m.stopDeviceScan().catch(() => {});
      err ? reject(err) : resolve();
    };
    // Filter by nothing: some printers only put their name in the advert.
    void m.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        const code = error.errorCode === 102 ? "poweredOff" : error.errorCode === 101 ? "unauthorized" : error.errorCode === 100 ? "unsupported" : "unknown";
        finish(new PrinterError(code, error.message));
        return;
      }
      if (!device) return;
      const name = device.name ?? device.localName;
      if (!name) return;
      const services = (device.serviceUUIDs ?? []).map(norm);
      const likelyPrinter = services.some((s) => PRINTER_SERVICE_UUIDS.includes(s)) || PRINTER_NAME.test(name);
      found.set(device.id, { id: device.id, name, rssi: device.rssi, likelyPrinter });
      emit();
    });
    setTimeout(() => finish(), durationMs);
  });
  emit();
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Transport

export interface BleTransportOptions {
  id: string;
  name: string;
  /** Known-good characteristic from a previous session — skips the search. */
  serviceUUID?: string;
  characteristicUUID?: string;
  writeWithResponse?: boolean;
  /** Called once the writable characteristic is known, so callers can remember it. */
  onCharacteristicFound?: (serviceUUID: string, characteristicUUID: string, withResponse: boolean) => void;
}

/** Hard cap per write; the actual size is min(this, MTU − 3). */
const MAX_CHUNK = 180;
const CHUNK_DELAY_MS = 25;
const CONNECT_TIMEOUT_MS = 12_000;

export function createBleTransport(opts: BleTransportOptions): PrinterTransport {
  let device: Device | null = null;
  let service = opts.serviceUUID;
  let characteristic = opts.characteristicUUID;
  let withResponse = opts.writeWithResponse ?? false;
  let chunk = 20;

  async function findWritable(d: Device): Promise<void> {
    const services = await d.services();
    const candidates: { s: string; c: string; withResponse: boolean; score: number }[] = [];
    for (const s of services) {
      const su = norm(s.uuid);
      if (su.startsWith("00001800") || su.startsWith("00001801")) continue; // GAP / GATT
      const chars = await s.characteristics();
      for (const c of chars) {
        if (!c.isWritableWithoutResponse && !c.isWritableWithResponse) continue;
        const cu = norm(c.uuid);
        const preferred = PREFERRED_WRITE[su] === cu ? 4 : PRINTER_SERVICE_UUIDS.includes(su) ? 2 : 0;
        candidates.push({ s: s.uuid, c: c.uuid, withResponse: !c.isWritableWithoutResponse, score: preferred + (c.isWritableWithoutResponse ? 1 : 0) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) throw new PrinterError("noWritableCharacteristic");
    service = best.s;
    characteristic = best.c;
    withResponse = best.withResponse;
    opts.onCharacteristicFound?.(service, characteristic, withResponse);
  }

  return {
    id: opts.id,
    name: opts.name,
    kind: "ble",

    async connect() {
      const m = getBleManager();
      if (!m) throw new PrinterError("unsupported");
      const state = await getBleState();
      if (state === "unsupported" || state === "poweredOff" || state === "unauthorized") throw new PrinterError(state);
      if (!(await ensureAndroidPermissions())) throw new PrinterError("unauthorized");
      try {
        device = await withTimeout(m.connectToDevice(opts.id, { requestMTU: Platform.OS === "android" ? MAX_CHUNK + 3 : undefined, timeout: CONNECT_TIMEOUT_MS }), CONNECT_TIMEOUT_MS + 1000);
        await withTimeout(device.discoverAllServicesAndCharacteristics(), 10_000);
      } catch (e) {
        if (e instanceof PrinterError) throw e;
        throw new PrinterError("notFound", e instanceof Error ? e.message : String(e));
      }
      // iOS negotiates the MTU itself and reports it on the device.
      const mtu = device.mtu && device.mtu > 23 ? device.mtu : 23;
      chunk = Math.max(20, Math.min(MAX_CHUNK, mtu - 3));
      if (!service || !characteristic) await findWritable(device);
    },

    async write(bytes) {
      if (!device || !service || !characteristic) throw new PrinterError("disconnected");
      for (let off = 0; off < bytes.length; off += chunk) {
        const part = toBase64(bytes.subarray(off, Math.min(bytes.length, off + chunk)));
        try {
          if (withResponse) await withTimeout(device.writeCharacteristicWithResponseForService(service, characteristic, part), 5000);
          else await withTimeout(device.writeCharacteristicWithoutResponseForService(service, characteristic, part), 5000);
        } catch (e) {
          if (e instanceof PrinterError) throw e;
          throw new PrinterError("disconnected", e instanceof Error ? e.message : String(e));
        }
        // Without-response writes have no back-pressure: give the printer's
        // tiny buffer a moment, and the radio time to actually send.
        if (!withResponse) await sleep(CHUNK_DELAY_MS);
      }
      // Let the last chunk drain before the caller tears the link down.
      await sleep(150);
    },

    async disconnect() {
      const m = getBleManager();
      const d = device;
      device = null;
      if (!m || !d) return;
      try {
        await withTimeout(m.cancelDeviceConnection(d.id), 3000);
      } catch {
        // already gone — that is the outcome we wanted
      }
    },
  };
}
