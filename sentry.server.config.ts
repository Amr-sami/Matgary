// Server-side Sentry init. Only fires when SENTRY_DSN is set, so dev stays
// quiet and there's nothing to undo if the project decides to drop Sentry.
import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    // Sample 10% of traces by default; bump via SENTRY_TRACES_RATE for incidents.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE ?? 0.1),
    // Don't ship local-only failures (DB down on a dev box, etc.) to prod Sentry.
    enabled: process.env.NODE_ENV !== "test",
  });
}
