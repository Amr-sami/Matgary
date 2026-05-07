// Browser-side Sentry init. Same env-gate so missing DSN is a no-op.
import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE ?? 0.1),
    // Replay is opt-in via SENTRY_REPLAYS=1 — keeps the bundle slim by default.
    replaysOnErrorSampleRate: process.env.SENTRY_REPLAYS === "1" ? 1.0 : 0,
    replaysSessionSampleRate: 0,
    enabled: process.env.NODE_ENV !== "test",
  });
}
