// H08 — Content Security Policy. Per-request nonce so we don't have to ship
// 'unsafe-inline' for scripts. middleware.ts sends it Report-Only by default
// until staging proves the policy clean; CSP_ENFORCE=1 flips it to enforcement.
//
// `style-src` keeps `'unsafe-inline'` for v1 because Tailwind 4 injects
// runtime inline styles without a nonce hook today. Tracked in task.md §4
// backlog "Strict CSP for styles".
//
// Host wildcards: CSP allows `*` only as the LEFT-MOST label (`*.example.com`,
// which matches any deeper subdomain too). `https://o*.ingest.sentry.io` was
// invalid, and browsers ignored it with a console warning on every page
// (audit web W3). Sentry's DSN hosts (`o<org>.ingest[.<region>].sentry.io`)
// are covered by `https://*.ingest.sentry.io` and by `https://*.sentry.io`.
export function buildCspHeader(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.sentry.io https://*.ingest.sentry.io",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ];
  return directives.join("; ");
}
