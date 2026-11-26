// Next.js runs this once per server boot (App Router only).
//
// Two responsibilities, both runtime-gated so the Edge bundle stays clean:
//   1. Initialise Sentry as early as the runtime allows. Next 16 best
//      practice — earlier than the side-effect import in the legacy
//      sentry.{server,edge,client}.config.ts files — so unhandled rejections
//      during the next few microseconds of boot are still captured.
//   2. Start the WhatsApp BullMQ worker on Node so background jobs drain
//      on every node that's also serving HTTP. The single-instance deploy
//      model makes co-locating fine; when we move to dedicated worker
//      containers the same `lib/whatsapp/worker-bootstrap` is imported
//      there without the HTTP routes.

export async function register(): Promise<void> {
  // Sentry — branches on runtime since the server and edge configs differ.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }

  // OpenTelemetry — opt-in via OTEL_SERVICE_NAME (or any standard
  // OTEL_EXPORTER_OTLP_* env var). Off by default so local dev stays
  // quiet. When enabled, `@vercel/otel` installs the standard tracer +
  // OTLP exporter, instruments fetch / node:http / postgres-js, and
  // emits spans that any OTEL collector (Jaeger, Tempo, Honeycomb,
  // Datadog) can ingest.
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.OTEL_SERVICE_NAME
  ) {
    const { registerOTel } = await import("@vercel/otel");
    registerOTel({
      serviceName: process.env.OTEL_SERVICE_NAME,
      // Auto-detects OTLP endpoint + headers from OTEL_EXPORTER_OTLP_*
      // env vars. No collector → exporter is a no-op.
      // We DON'T auto-instrument every fetch because we'd then trace the
      // outbound calls to Meta / Paymob / Sentry too — that's a lot of
      // noise. Future: add explicit fetch instrumentation with allow-list.
    });
  }

  // Background workers — Node only, opt-in via REDIS_URL.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.REDIS_URL) return;
  const { bootWorker } = await import("./lib/whatsapp/worker-bootstrap");
  await bootWorker();

  // Activity-log worker — additional opt-in flag because flipping it on
  // makes audit writes eventually-consistent. The worker is also Node-only;
  // dynamic import keeps the Edge bundle clean.
  if (process.env.ACTIVITY_LOG_QUEUE === "1") {
    const { bootActivityWorker } = await import(
      "./lib/queue/activity-worker-bootstrap"
    );
    await bootActivityWorker();
  }
}

/**
 * Capture uncaught errors during request handling. Next 16 calls this hook
 * before rendering the error UI, so we get the request method/url/headers
 * snapshot alongside the error.
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string> },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureRequestError(err, request, {
      routerKind: "App Router",
      routePath: request.path,
      routeType: "route",
    });
  } catch {
    // Never let observability throw and break the actual error flow.
  }
}
