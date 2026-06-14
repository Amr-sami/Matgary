// Standard HTTP cache headers for read endpoints.
//
// Pattern: catalog + settings reads ship slow-changing per-tenant data
// that multiple components on the same page consume. Without `Cache-
// Control`, the browser refetches on every navigation even when Redis
// is warm — three tiers of cache (browser, app/Redis, DB) collapse into
// one. With these headers, repeat consumers and back-navigations are
// served from the local disk cache, eliminating the round-trip
// entirely.
//
// Use `private` (not `public`) for everything tenant-scoped — these
// responses MUST NOT be cached by shared proxies / CDN because their
// contents depend on the auth cookie. Browser-private cache is fine.
//
// Don't apply to time-series (sales/returns/expenses): those rotate
// fast and stale reads would mislead users.

export interface CacheWindow {
  /** Browser holds the cached body as fresh for this many seconds. */
  maxAge: number;
  /** After maxAge, browser may keep serving the stale body for this
   *  many seconds while it revalidates in the background. */
  swr: number;
}

export const CATALOG_CACHE: CacheWindow = { maxAge: 60, swr: 300 };
export const SETTINGS_CACHE: CacheWindow = { maxAge: 60, swr: 300 };
export const BRANCH_CACHE: CacheWindow = { maxAge: 120, swr: 600 };

export function cacheHeaders(w: CacheWindow): HeadersInit {
  return {
    "Cache-Control": `private, max-age=${w.maxAge}, stale-while-revalidate=${w.swr}`,
    Vary: "Cookie",
  };
}
