// Browser-side Sentry init. Same env-gate so missing DSN is a no-op.
import * as Sentry from "@sentry/nextjs";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "@/lib/sentry/scrub";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE ?? 0.1),
    // Replay is opt-in via SENTRY_REPLAYS=1 — keeps the bundle slim by default.
    replaysOnErrorSampleRate: process.env.SENTRY_REPLAYS === "1" ? 1.0 : 0,
    replaysSessionSampleRate: 0,
    // F-02 — same scrubber as server. Catches fetch/xhr breadcrumb URLs
    // and any client-side `Sentry.captureException(err, { extra: ... })`.
    // Same cast as the server config — see sentry.server.config.ts.
    beforeSend(event) {
      const scrubbed = scrubSentryEvent(event as unknown as Record<string, unknown>);
      return scrubbed as unknown as typeof event;
    },
    beforeBreadcrumb(crumb) {
      const scrubbed = scrubSentryBreadcrumb(crumb as unknown as Record<string, unknown>);
      return scrubbed as unknown as typeof crumb;
    },
    enabled: process.env.NODE_ENV !== "test",
  });
}
