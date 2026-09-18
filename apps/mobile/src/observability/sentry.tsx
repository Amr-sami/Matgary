/**
 * Sentry for the mobile app (doc 06 §2.11, §10.2).
 *
 * Same org as the web, project `thestoro-mobile`, and the SAME scrubber the
 * web runs — `@matgary/domain/observability/scrub` — wired through
 * `beforeSend` / `beforeBreadcrumb`. Anything the web refuses to ship
 * (tokens, passwords, cookies, customer phone/name) is refused here too, from
 * one denylist.
 *
 * Wiring (the root layout owns the mount points; this module owns the how):
 *   - `initSentry()`      module top of app/_layout.tsx, before any render.
 *   - `wrapRoot(Root)`    `export default wrapRoot(RootLayout)` — touch
 *                          breadcrumbs, app-start + profiler spans.
 *   - `useSentryNavigationTracking()` one call inside RootLayout so route
 *                          changes become navigation spans (expo-router is
 *                          React Navigation underneath).
 *   - `RouteErrorFallback` see the JSDoc — expo-router has no `+error.tsx`;
 *                          error boundaries are a named `ErrorBoundary` export
 *                          from a route or layout file.
 *
 * Without EXPO_PUBLIC_SENTRY_DSN every export is a safe no-op, so the dev
 * client, tests and CI never need a DSN.
 */
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Sentry from "@sentry/react-native";
import * as Application from "expo-application";
import * as Updates from "expo-updates";
import { useNavigationContainerRef } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from "@matgary/domain/observability/scrub";

import { getLocale, t } from "@/i18n";
import { setPerfReporter } from "@/observability/perf";
import { directionStyle, RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, MIN_TOUCH, radius, spacing } from "@/theme/tokens";

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim() || undefined;

/** Parsed once at module load; anything unparseable / out of range falls back to 0.1. */
const TRACES_SAMPLE_RATE = (() => {
  const raw = Number(process.env.EXPO_PUBLIC_SENTRY_TRACES_RATE ?? 0.1);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.1;
})();

let initialised = false;
let warnedOnce = false;

/**
 * Created once at module scope so `useSentryNavigationTracking` can register
 * the container ref on the very same instance `init` received. Cheap to
 * construct; only `init` activates it.
 */
const navigationIntegration = Sentry.reactNavigationIntegration({
  // Expo Router route names are file paths ("(app)/sales"); the full path is
  // what makes the span readable in the Sentry UI.
  useFullPathsForNavigationRoutes: true,
  // A "back" that lands on an already-rendered screen produces an empty
  // transaction — skip those, they are noise in the performance tab.
  ignoreEmptyBackNavigationTransactions: true,
});

/** True once `Sentry.init` ran with a DSN. False in dev without one. */
export function isSentryEnabled(): boolean {
  return initialised;
}

/**
 * Release identity (doc 06 §10.2): `<version>+<updateId|embedded>`. Including
 * the OTA update id is what lets a crash be pinned to the update that shipped
 * it rather than to the store binary. `dist` is the native build number.
 */
export function releaseInfo(): { release: string; dist: string | undefined } {
  const version = Application.nativeApplicationVersion ?? "0.0.0";
  const update = Updates.updateId ?? "embedded";
  return {
    release: `${version}+${update}`,
    dist: Application.nativeBuildVersion ?? undefined,
  };
}

/**
 * Idempotent. Called at module top of the root layout; safe to call again
 * (fast refresh re-evaluates that module).
 */
export function initSentry(): void {
  if (initialised) return;
  if (!DSN) {
    if (__DEV__ && !warnedOnce) {
      warnedOnce = true;
      console.info(
        "[sentry] EXPO_PUBLIC_SENTRY_DSN is not set — error reporting is off for this session.",
      );
    }
    return;
  }

  const { release, dist } = releaseInfo();

  Sentry.init({
    dsn: DSN,
    // Dev builds report as "development"; EAS builds report their update
    // channel ("production", "preview") so the two never mix in one issue.
    environment: __DEV__ ? "development" : (Updates.channel ?? "production"),
    release,
    dist,

    enableNative: true,
    enableNativeCrashHandling: true,
    attachStacktrace: true,
    enableAutoSessionTracking: true,

    // Mirrors the web's SENTRY_TRACES_RATE default (0.1 in all three
    // sentry.*.config.ts) so a fleet of POS devices does not out-sample the
    // server; bump per-incident via EXPO_PUBLIC_SENTRY_TRACES_RATE.
    tracesSampleRate: TRACES_SAMPLE_RATE,
    integrations: [Sentry.reactNativeTracingIntegration(), navigationIntegration],

    // A POS screen shows customer PII continuously (doc 06 §10.2) — replay is
    // off, and stays off. sendDefaultPii off means no IP / device identifiers
    // are auto-attached either; identity is the opaque user id from setUser.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendDefaultPii: false,

    // The shared scrubber. `scrubSentryEvent` is typed structurally over the
    // Sentry event shape (request/extra/contexts/user), so the same function
    // runs unchanged in @sentry/nextjs and here.
    beforeSend: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (crumb) => scrubSentryBreadcrumb(crumb),

    // Network failures are NOT ignored in release builds: the outbox drainer's
    // errors are network errors, and the `online` / `outboxDepth` tags exist so
    // a wrong API host or a flaky carrier is diagnosable rather than silent.
    // Only the dev client (Metro reloads, simulator without a server) drops
    // them as noise. AbortError is a deliberate cancellation on every platform.
    ignoreErrors: __DEV__ ? ["Network request failed", "AbortError"] : ["AbortError"],
  });

  Sentry.setTag("locale", getLocale());
  initialised = true;
  // perf.ts imports nothing (its `js-start` stamp must precede every other
  // module's evaluation), so the tracing side plugs in here rather than
  // being imported there. Until this line, measures compute but file nothing.
  setPerfReporter({ startSpan, setMeasurement });
}

/**
 * Wrap the root component. `Sentry.wrap` adds the touch-event boundary (UI
 * breadcrumbs) and the app-start / profiler instrumentation. Identity when
 * Sentry is off so the dev client renders the plain tree.
 */
export function wrapRoot<P extends Record<string, unknown>>(
  Root: ComponentType<P>,
): ComponentType<P> {
  if (!initialised) return Root;
  return Sentry.wrap(Root);
}

/**
 * Registers expo-router's navigation container with the navigation
 * integration so each route change becomes a navigation span. Call once inside
 * the root layout component body (it is a hook). No-op without a DSN.
 */
export function useSentryNavigationTracking(): void {
  const ref = useNavigationContainerRef();
  useEffect(() => {
    if (!initialised || !ref) return;
    navigationIntegration.registerNavigationContainer(ref);
  }, [ref]);
}

// ---------------------------------------------------------------------------
// Identity + diagnostic tags
// ---------------------------------------------------------------------------

/**
 * Identity is IDs only — never email, phone or name (doc 06 §10.2). Tenant and
 * branch go on as tags so issues can be filtered per store from the event
 * alone. Pass `null` on logout to clear.
 */
export function setUser(
  userId: string | null,
  tenantId?: string | null,
  branchId?: string | null,
  role?: string | null,
): void {
  if (!initialised) return;
  if (!userId) {
    Sentry.setUser(null);
    Sentry.setTags({ tenantId: undefined, branchId: undefined, role: undefined });
    return;
  }
  Sentry.setUser({ id: userId });
  Sentry.setTags({
    tenantId: tenantId ?? undefined,
    branchId: branchId ?? undefined,
    role: role ?? undefined,
  });
}

/**
 * The diagnostic tags doc 06 §10.2 says make most offline bug reports
 * readable from the event alone. Each subsystem sets the ones it owns:
 * the outbox drainer `outboxDepth`, the connectivity store `online`, the
 * catalog sync `catalogAgeMinutes`, the locale store `locale`.
 */
export function setDiagnosticTags(
  tags: Partial<{
    locale: string;
    online: boolean;
    outboxDepth: number;
    catalogAgeMinutes: number;
  }>,
): void {
  if (!initialised) return;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  Sentry.setTags(out);
}

/**
 * Report a handled error with optional structured context. Context goes
 * through the shared scrubber like everything else, but the rule stands: pass
 * ids and counts, never the customer or the sale payload. Returns the event id
 * when Sentry is on so a screen can show "Report ID" next to the error.
 */
export function captureException(
  error: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): string | undefined {
  if (!initialised) {
    if (__DEV__) console.error("[sentry:off]", error, context?.extra ?? "");
    return undefined;
  }
  return Sentry.captureException(error, {
    tags: context?.tags,
    extra: context?.extra,
  });
}

// ---------------------------------------------------------------------------
// Spans + measurements (doc 06 §10.3 rule 7 — the marks in observability/perf.ts)
// ---------------------------------------------------------------------------

/** A started span; `end()` closes it. A no-op object when Sentry is off. */
export interface SpanHandle {
  /** Close the span, at `endTimestampMs` (epoch ms) or now. */
  end(endTimestampMs?: number): void;
}

const NOOP_SPAN: SpanHandle = { end() {} };

/**
 * Start a span that is NOT made the active span (it wraps no callback, so it
 * cannot leak onto unrelated work). With an active transaction — the app-start
 * one during boot, the navigation one on a screen — it becomes that
 * transaction's child; otherwise it is its own root, sampled by
 * `tracesSampleRate`. `startTimestampMs` back-dates the start so an interval
 * measured with performance marks is filed with its real boundaries.
 */
export function startSpan(
  name: string,
  op: string,
  opts?: {
    startTimestampMs?: number;
    attributes?: Record<string, string | number | boolean>;
  },
): SpanHandle {
  if (!initialised) return NOOP_SPAN;
  const span = Sentry.startInactiveSpan({
    name,
    op,
    startTime: opts?.startTimestampMs,
    attributes: opts?.attributes,
  });
  return { end: (endTimestampMs) => span.end(endTimestampMs) };
}

/**
 * A millisecond measurement on the active transaction (rule 7: "reported to
 * Sentry as measurements"), so boot phases and POS spans can be charted
 * against the §10.3 budgets. No-op without a DSN or an active span.
 */
export function setMeasurement(name: string, valueMs: number): void {
  if (!initialised) return;
  Sentry.setMeasurement(name, valueMs, "millisecond");
}

/** Breadcrumb for the custom instrumentation the spec lists (scan, drain, print). */
export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!initialised) return;
  Sentry.addBreadcrumb({ category, message, data, level: "info" });
}

// ---------------------------------------------------------------------------
// Error boundary fallback
// ---------------------------------------------------------------------------

/**
 * Bilingual "something went wrong" screen with a Try-again button. Matches
 * expo-router's `ErrorBoundaryProps` (`{ error, retry }`) so it drops straight
 * into a route's error boundary. Reports the error to Sentry once per mount
 * and surfaces the event id so support can find the report.
 *
 * How to mount (root layout is owned by another agent — this is the recipe):
 *
 *   // app/_layout.tsx  (or any (group)/_layout.tsx / screen file)
 *   export { RouteErrorFallback as ErrorBoundary } from "@/observability/sentry";
 *
 * expo-router 57 does NOT support a `+error.tsx` route file — `getRoutesCore`
 * rejects every `+`-prefixed name except `+not-found`. The named
 * `ErrorBoundary` export from a route or layout is the supported mechanism;
 * exporting it from the ROOT layout catches everything below it.
 *
 * Note that expo-router wraps the EXPORTING route's own component in
 * `<Try catch={ErrorBoundary}>` (useScreens.js `fromImport`), so an
 * `ErrorBoundary` exported from `(app)/_layout.tsx` replaces the whole
 * `<Tabs>` — tab bar included — when a screen throws. To keep the tab chrome
 * alive around a broken screen, either export `ErrorBoundary` from each
 * screen file, or use the layout-level setting that wraps every CHILD screen
 * instead of the layout itself:
 *
 *   // app/(app)/_layout.tsx
 *   export const unstable_settings = { screenErrorBoundary: RouteErrorFallback };
 *
 * `SentryErrorBoundary` below is the alternative for wrapping an arbitrary
 * subtree (e.g. a modal) outside the router.
 */
export function RouteErrorFallback({
  error,
  retry,
  eventId: reportedEventId,
}: ErrorBoundaryProps & {
  /**
   * Event id of a report an outer boundary already made (e.g.
   * `Sentry.ErrorBoundary`'s `componentDidCatch`). When set, the fallback
   * shows it instead of capturing a second, duplicate event.
   */
  eventId?: string;
}) {
  const rtl = getLocale() === "ar";
  const eventId = useReportedOnce(error, reportedEventId);

  return (
    <View style={[styles.root, directionStyle(rtl)]}>
      <View style={styles.iconWrap}>
        <WarningCircle size={40} color={colors.danger} weight="duotone" />
      </View>
      <Text style={styles.title}>{t("mobile.errors.title")}</Text>
      <Text style={styles.body}>{t("mobile.errors.body")}</Text>
      {eventId ? (
        <>
          <Text style={styles.meta}>{t("mobile.errors.reported")}</Text>
          <Text style={styles.eventId} selectable>
            {t("mobile.errors.eventId", { id: eventId.slice(0, 8) })}
          </Text>
        </>
      ) : null}
      {__DEV__ ? (
        <Text style={styles.devMessage} numberOfLines={4} selectable>
          {error.message}
        </Text>
      ) : null}
      <Pressable
        onPress={() => void retry()}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.errors.tryAgain")}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonLabel} numberOfLines={1}>
          {t("mobile.errors.tryAgain")}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * `Sentry.ErrorBoundary` pre-configured with the same fallback, for subtrees
 * outside expo-router's route boundaries. Usage:
 *
 *   <SentryErrorBoundary><Modal …/></SentryErrorBoundary>
 */
export function SentryErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <Sentry.ErrorBoundary
      // `Sentry.ErrorBoundary.componentDidCatch` already captured the error
      // and hands us its `eventId`; pass it through so the cashier sees THAT
      // report id and no second event is filed for the same throw.
      fallback={({ error, resetError, eventId }) => (
        <RouteErrorFallback
          error={error instanceof Error ? error : new Error(String(error))}
          retry={async () => resetError()}
          eventId={eventId}
        />
      )}
    >
      {children}
    </Sentry.ErrorBoundary>
  );
}

/**
 * Reports `error` once for this boundary mount and returns the event id.
 * `retry()` unmounts the fallback, so a second throw reports again — intended.
 * When `alreadyReported` is given (an outer Sentry boundary captured it), no
 * capture happens and that id is returned as-is.
 */
function useReportedOnce(error: Error, alreadyReported?: string): string | undefined {
  const [eventId, setEventId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (alreadyReported) return;
    const id = captureException(error, { tags: { boundary: "route" } });
    if (id) setEventId(id);
  }, [error, alreadyReported]);
  return alreadyReported ?? eventId;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxl,
    gap: spacing.sm,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: radius.full,
    backgroundColor: colors.dangerLight,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 20,
    color: colors.text,
    textAlign: "center",
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
    textAlign: "center",
    maxWidth: 320,
  },
  meta: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.success,
    textAlign: "center",
    marginTop: spacing.sm,
  },
  eventId: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: "center",
  },
  devMessage: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.danger,
    backgroundColor: colors.dangerLight,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
    maxWidth: 320,
  },
  button: {
    marginTop: spacing.lg,
    minHeight: MIN_TOUCH,
    minWidth: 160,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPressed: {
    backgroundColor: colors.accentPressed,
  },
  buttonLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.bg,
  },
});
