// Lightweight scanner timing tracker. Records performance marks across
// the scan lifecycle so we can compare click→modal→decoder→camera→scan
// latencies on real devices without devtools access.
//
// Module-level state keyed by mark name; reset on every new "click" so a
// fresh scan starts from t=0. All marks are in milliseconds since the
// page Performance time origin.
//
// Visibility: enabled only when `?perf=1` is in the URL. The overlay
// component (rendered inside the scanner modal) reads the marks and
// shows them on screen. No network IO, no localStorage, no PII.

type TimingKey = "click" | "modal" | "decoder" | "firstFrame" | "firstScan";

const marks: Partial<Record<TimingKey, number>> = {};
const subscribers = new Set<() => void>();

export function isScanPerfEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(window.location.href).searchParams.get("perf") === "1";
  } catch {
    return false;
  }
}

export function markScan(key: TimingKey): void {
  if (typeof performance === "undefined") return;
  if (key === "click") {
    // Fresh scan cycle — wipe previous marks so a second click resets
    // every downstream measurement.
    (Object.keys(marks) as TimingKey[]).forEach((k) => delete marks[k]);
  }
  marks[key] = performance.now();
  // Console mirror for browsers connected to Mac Web Inspector or
  // chrome://inspect. Format keeps it greppable.
  if (isScanPerfEnabled() && typeof console !== "undefined") {
    const dt = marks.click != null ? (marks[key]! - marks.click).toFixed(0) : "?";
    // eslint-disable-next-line no-console
    console.log(`[scanner-perf] ${key} +${dt}ms`);
  }
  subscribers.forEach((cb) => cb());
}

export interface ScanReport {
  marks: Partial<Record<TimingKey, number>>;
  deltas: Partial<Record<TimingKey, number>>;
}

export function getScanReport(): ScanReport {
  const click = marks.click;
  const deltas: Partial<Record<TimingKey, number>> = {};
  if (click != null) {
    (Object.entries(marks) as [TimingKey, number][]).forEach(([k, v]) => {
      deltas[k] = Math.round(v - click);
    });
  }
  return { marks: { ...marks }, deltas };
}

export function subscribeScanPerf(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
