/**
 * Shared sensitive-data scrubber for Sentry events + breadcrumbs.
 *
 * Closes F-02 from docs/specs/security-review-validation.md:
 * the previous configs had no beforeSend hook, so the day someone added
 * a careless `console.error(req.body)` or `Sentry.captureException(err,
 * { extra: { req } })`, every password / 2FA code / session cookie in
 * that request shipped to Sentry intact.
 *
 * The scrubber is intentionally aggressive — false positives ("REDACTED"
 * showing up in a debug session) are vastly cheaper than a leak.
 */

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
]);

const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "oldpassword",
  "currentpassword",
  "confirmpassword",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "csrftoken",
  "csrf_token",
  "secret",
  "totp",
  "totpsecret",
  "code",
  "recoverycode",
  "recoverycodeshash",
  "apikey",
  "api_key",
  "authorization",
]);

const REDACTED = "[REDACTED]";

export function scrubObject(input: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED; // depth guard against circular / deep structures
  if (input == null) return input;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((v) => scrubObject(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase())
      ? REDACTED
      : scrubObject(v, depth + 1);
  }
  return out;
}

export function scrubHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

interface SentryLikeEvent {
  request?: {
    headers?: Record<string, string>;
    data?: unknown;
    cookies?: unknown;
    query_string?: unknown;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  user?: { ip_address?: string };
}

/**
 * Scrub a Sentry event in place + return it. Safe to call from both the
 * server-side and client-side `beforeSend` hooks.
 */
export function scrubSentryEvent<T extends SentryLikeEvent>(event: T): T {
  if (event.request) {
    event.request.headers = scrubHeaders(event.request.headers);
    if (event.request.data !== undefined) {
      event.request.data = scrubObject(event.request.data);
    }
    if (event.request.cookies !== undefined) {
      event.request.cookies = REDACTED;
    }
    // query_string may carry tokens (e.g., reset-password ?token=...)
    if (typeof event.request.query_string === "string") {
      event.request.query_string = event.request.query_string.replace(
        /([?&](?:token|code|secret|hmac|password)=)[^&]*/gi,
        "$1[REDACTED]",
      );
    }
  }
  if (event.extra) {
    event.extra = scrubObject(event.extra) as Record<string, unknown>;
  }
  if (event.contexts) {
    event.contexts = scrubObject(event.contexts) as Record<string, unknown>;
  }
  return event;
}

interface SentryLikeBreadcrumb {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Scrub a breadcrumb. Console breadcrumbs are the highest-risk path:
 * any `console.error(req)` would otherwise land here unredacted.
 */
export function scrubSentryBreadcrumb<T extends SentryLikeBreadcrumb>(crumb: T): T {
  if (crumb.data) {
    crumb.data = scrubObject(crumb.data) as Record<string, unknown>;
  }
  // Some categories (xhr, fetch) carry full URLs as the message — strip
  // sensitive query params there too.
  if (typeof crumb.message === "string") {
    crumb.message = crumb.message.replace(
      /([?&](?:token|code|secret|hmac|password)=)[^&\s]*/gi,
      "$1[REDACTED]",
    );
  }
  return crumb;
}
