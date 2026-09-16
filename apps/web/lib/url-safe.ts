/**
 * The app's public origin, for building absolute URLs inside route handlers.
 *
 * `req.url` and `req.nextUrl.origin` cannot be used for this in a self-hosted
 * standalone build. server.js runs with `trustHostHeader: false` and derives
 * the origin from HOSTNAME, which the Dockerfile pins to 0.0.0.0 — so
 * `new URL("/ar/login", req.url)` yields https://0.0.0.0:3000/ar/login and the
 * browser is redirected somewhere unreachable. Middleware is NOT affected
 * (its nextUrl comes from the incoming request), which is why only
 * route-handler redirects break, and why it never shows up in `next dev`
 * where hostname is unset and resolves to localhost.
 *
 * Resolution order: explicit config, then the reverse proxy's forwarded host,
 * then the request itself as a last resort.
 */
export function appOrigin(req: { headers: Headers; url: string }): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host}`;
  }

  return new URL(req.url).origin;
}

/**
 * Sanitize a user-supplied "next" / "redirect" URL down to a same-origin,
 * relative path. Anything that could escape (absolute URLs, protocol-
 * relative, backslash-prefixed) collapses to "/" so an attacker can't turn
 * /ar/login?next=https://evil.com into an open redirect after login.
 *
 * Keep the query string + hash if present — but only when the path itself
 * is safe. e.g. "/reports?from=yesterday" is fine, "//evil.com/?foo" isn't.
 */
export function safeNext(raw: string | null | undefined, fallback = "/"): string {
  if (!raw) return fallback;
  if (typeof raw !== "string") return fallback;
  // Must start with a single slash and a non-slash character.
  // Rejects: "https://...", "//host/...", "/\\evil", "javascript:...".
  if (!raw.startsWith("/")) return fallback;
  if (raw.length > 1 && (raw[1] === "/" || raw[1] === "\\")) return fallback;
  return raw;
}
