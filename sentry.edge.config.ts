// Edge-runtime Sentry init (middleware + edge route handlers). Same env-gate
// as the server config so an unset DSN is a no-op.
import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE ?? 0.1),
    enabled: process.env.NODE_ENV !== "test",
  });
}
