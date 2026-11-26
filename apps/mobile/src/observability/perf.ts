/**
 * Performance marks (doc 06 §10.3 rule 7; perf.md §5).
 *
 * `mark(name)` stamps a point on the monotonic clock; `measure(name, from)`
 * turns two marks into a duration and, when a reporter is registered (Sentry
 * with a DSN), into a span plus a measurement on the active transaction — the
 * app-start transaction for the boot phases, the screen's navigation
 * transaction for the POS spans. Without a reporter nothing leaves the device;
 * in `__DEV__` the boot table is printed once the dashboard has its first live
 * answer (or, failing that, after a bounded wait — see `reportBoot`).
 *
 * THIS MODULE HAS NO RUNTIME IMPORTS, ON PURPOSE. It is the first thing the
 * root layout imports, and `js-start` is stamped when it evaluates. Anything
 * it imported would be evaluated BEFORE that stamp (Expo SDK 57's Metro
 * transform hoists imports and does not inline requires), hiding that slice of
 * the JS phase inside the origin where no regression could ever show. So the
 * Sentry side registers itself here (`setPerfReporter`, called from
 * `initSentry`) instead of being imported. The one `import type` below is
 * erased at compile time.
 *
 * The four boot phases:
 *   js-start        this module evaluated — the first APP-SIDE line of JS that
 *                   runs. Framework code (react-native, expo-router's entry)
 *                   has already run by then; since the clock's origin is
 *                   process start, the absolute value is native start + bundle
 *                   load + framework evaluation, before any app code.
 *   bootstrap-done  session.bootstrap() decided `status` (signedIn/signedOut).
 *   first-screen    the splash lifted: fonts + session ready, first frame up.
 *   dashboard-data  the dashboard query's first LIVE answer (not the hydrated
 *                   snapshot) — the cashier can trust the numbers.
 *
 * Every phase is filed (`boot.<phase>` span + measurement from `js-start`) the
 * moment it is marked, so an offline cold start, a signed-out boot, or a
 * dashboard that never answers still reports the phases it did reach.
 *
 * The POS spans (`pos.*`) are stamped by ScannerSheet and sales.tsx:
 *   pos.scan-decode       camera mounted → first accepted barcode
 *   pos.scan-to-cart      barcode accepted → line added to the cart
 *   pos.checkout-receipt  checkout tap → receipt card committed
 *
 * The clock is `performance.now()` (Hermes exposes it; RN's Performance API
 * makes its origin the process start, so `js-start` is meaningful on its own).
 * `Date.now()` is the fallback for an environment without it (tests).
 */
import type { QueryClient } from "@tanstack/react-query";

export type BootPhase = "js-start" | "bootstrap-done" | "first-screen" | "dashboard-data";
export const BOOT_PHASES: readonly BootPhase[] = [
  "js-start",
  "bootstrap-done",
  "first-screen",
  "dashboard-data",
];

type PerfLike = { now(): number };
const perf: PerfLike | null =
  typeof globalThis.performance === "object" &&
  typeof globalThis.performance?.now === "function"
    ? globalThis.performance
    : null;

/** Milliseconds on the monotonic clock (process-relative under RN). */
export function now(): number {
  return perf ? perf.now() : Date.now();
}

/**
 * Sentry wants wall-clock timestamps; the marks are monotonic. One offset,
 * taken at load, converts without letting a clock adjustment mid-session skew
 * a span's duration (both ends go through the same constant).
 */
const EPOCH_OFFSET_MS = Date.now() - now();
const toEpochMs = (mono: number): number => EPOCH_OFFSET_MS + mono;

// ---------------------------------------------------------------------------
// Reporter — the Sentry side plugs in here (observability/sentry.tsx)
// ---------------------------------------------------------------------------

/** A started span; `end()` closes it at `endTimestampMs` (epoch ms) or now. */
export interface PerfSpan {
  end(endTimestampMs?: number): void;
}

/** What `measure` needs from the tracing backend; registered by `initSentry`. */
export interface PerfReporter {
  startSpan(
    name: string,
    op: string,
    opts: { startTimestampMs: number; attributes?: Record<string, string | number | boolean> },
  ): PerfSpan;
  setMeasurement(name: string, valueMs: number): void;
}

let reporter: PerfReporter | null = null;

/**
 * Register (or, with null, remove) the backend that receives measured
 * intervals. Called by `initSentry` once a DSN is configured; until then, and
 * without one, measurements are computed and returned but go nowhere.
 */
export function setPerfReporter(next: PerfReporter | null): void {
  reporter = next;
}

// ---------------------------------------------------------------------------
// Marks + measures
// ---------------------------------------------------------------------------

const marks = new Map<string, number>();

/** Stamp `name` now. Re-marking overwrites — the latest occurrence is the one measured. */
export function mark(name: string): number {
  const at = now();
  marks.set(name, at);
  return at;
}

/** The mark's time, or null when it was never set (or was cleared). */
export function getMark(name: string): number | null {
  return marks.get(name) ?? null;
}

/** Forget a start mark so a later, unrelated end cannot be measured against it. */
export function clearMark(name: string): void {
  marks.delete(name);
}

export type MeasureOptions = {
  /** End of the interval; defaults to now (and stamps it as a mark under `name`). */
  to?: number;
  /** Span op. Defaults to "boot" for `boot.*` names, "pos" for `pos.*`, else "measure". */
  op?: string;
  /** Extra span attributes (ids and flags only — never customer or sale payloads). */
  attributes?: Record<string, string | number | boolean>;
  /** Remove the `from` mark once measured (one-shot intervals such as a scan). */
  consume?: boolean;
};

/**
 * Duration from mark `from` to now (or `opts.to`), in ms; null when `from` was
 * never marked. Handed to the reporter as a span named `name` and as a
 * millisecond measurement of the same name on the active transaction.
 */
export function measure(name: string, from: string, opts: MeasureOptions = {}): number | null {
  const start = marks.get(from);
  if (start === undefined) return null;
  const end = opts.to ?? now();
  const duration = Math.max(0, end - start);
  if (opts.consume) marks.delete(from);

  if (reporter) {
    const op = opts.op ?? (name.startsWith("boot.") ? "boot" : name.startsWith("pos.") ? "pos" : "measure");
    reporter
      .startSpan(name, op, { startTimestampMs: toEpochMs(start), attributes: opts.attributes })
      .end(toEpochMs(end));
    reporter.setMeasurement(name, duration);
  }
  return duration;
}

// ---------------------------------------------------------------------------
// Boot phases
// ---------------------------------------------------------------------------

// The first line of APP code to run: the root layout imports this module
// before anything else, and this module imports nothing, so this stamp is as
// close to "app JS started" as the bundle allows.
mark("js-start");

/** Each filed phase's offset from `js-start`, for the __DEV__ table. */
const bootDurations = new Map<BootPhase, number>();

/**
 * Stamp a boot phase AND file it at once: `boot.<phase>` span + measurement
 * from `js-start`. Filing per phase (rather than in one batch when the
 * dashboard answers) is what keeps a boot that never reaches the dashboard —
 * offline cold start, signed-out launch, a landing route other than the
 * dashboard, a fetch that errors — from losing the phases it DID reach.
 * The first stamp of a phase wins; a re-run (fast refresh re-evaluating the
 * root layout, a second `ready` commit) re-marks but does not re-file.
 */
export function markBoot(phase: Exclude<BootPhase, "js-start">): void {
  const at = mark(phase);
  if (bootDurations.has(phase)) return;
  const d = measure(`boot.${phase}`, "js-start", { to: at, op: "boot" });
  if (d !== null) bootDurations.set(phase, d);
  // From the first frame on, the dashboard has a bounded window to answer
  // before the table is printed with whatever it has.
  if (phase === "first-screen") armBootReportFallback();
}

let bootReported = false;
let bootReportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Longer than the API client's 15 s request timeout (packages/api-client
 * http.ts): a dashboard fetch that is going to answer has answered by then;
 * one that will not (offline, signed out, error) never will.
 */
const BOOT_REPORT_FALLBACK_MS = 20_000;

function armBootReportFallback(): void {
  if (bootReported || bootReportTimer) return;
  bootReportTimer = setTimeout(() => {
    bootReportTimer = null;
    reportBoot();
  }, BOOT_REPORT_FALLBACK_MS);
}

/**
 * The __DEV__ boot table: each phase's offset from `js-start`, printed once —
 * on the dashboard's first live answer, or after `BOOT_REPORT_FALLBACK_MS`
 * with "—" for the phases that never came. The spans themselves were filed as
 * each phase landed (`markBoot`), so this is display only.
 */
function reportBoot(): void {
  if (bootReported) return;
  bootReported = true;
  if (bootReportTimer) {
    clearTimeout(bootReportTimer);
    bootReportTimer = null;
  }
  if (!__DEV__) return;

  const origin = marks.get("js-start") ?? 0;
  const cells: string[] = [`js-start=${origin.toFixed(0)}ms`];
  for (const phase of BOOT_PHASES) {
    if (phase === "js-start") continue;
    const d = bootDurations.get(phase);
    cells.push(`${phase}=${d === undefined ? "—" : `+${d.toFixed(0)}ms`}`);
  }
  console.log(`[perf] boot  ${cells.join("  ")}`);
}

/**
 * Watches the query cache for the dashboard's first LIVE answer and stamps
 * `dashboard-data` from it. Hydration (`setQueryData` from the SQLite
 * snapshot) also dispatches a success, flagged `manual`, and is skipped: the
 * phase means "the server has answered", not "the cache was warm".
 *
 * Called once from the root layout, right after the QueryClient is created.
 * Unsubscribes itself after the first hit; never fires on a signed-out boot
 * (no dashboard query is ever created), which is the correct absence — the
 * fallback in `markBoot("first-screen")` prints the partial table instead.
 */
export function observeBootData(queryClient: QueryClient): () => void {
  if (marks.has("dashboard-data")) return () => {};
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    if ("manual" in event.action && event.action.manual) return;
    if (event.query.queryKey[0] !== "dashboard") return;
    markBoot("dashboard-data");
    unsubscribe();
    reportBoot();
  });
  return unsubscribe;
}
