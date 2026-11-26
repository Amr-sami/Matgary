/* Matgary service worker — minimal hand-rolled (no Workbox) so the
 * dependency surface stays one extra file in /public.
 *
 * Strategies:
 *   - Static assets (/_next/static/*, /fonts/*, /favicon.*) → cache-first.
 *     The build hashes filenames so a stale cache is harmless: the new
 *     deploy fetches new URLs.
 *   - App pages (HTML navigations) → network-first with cache fallback.
 *     This keeps the cashier on a working app shell when wifi blinks
 *     mid-shift, even if the landing page hasn't been visited recently.
 *   - /api/* → never cached. The outbox + bootstrap snapshot do the
 *     offline work; intercepting POSTs here would just add complexity.
 *
 * Versioning: bump CACHE_VERSION on any worker change to evict the old
 * cache entirely. Browsers run waitUntil(skipWaiting + clients.claim)
 * so the new SW takes over on the next page load without reloading.
 */

const CACHE_VERSION = "matgary-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGES_CACHE = `${CACHE_VERSION}-pages`;

// Pages we want pre-cached on install so a brand-new tablet that loses
// wifi between activation and the first visit can still open the cart.
const PRE_CACHE_PATHS = ["/sales", "/add-product", "/inventory"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PAGES_CACHE);
      // Best-effort prefetch — failures are silent so install still
      // succeeds even if the user's network was already flaky.
      await Promise.all(
        PRE_CACHE_PATHS.map((p) =>
          cache
            .add(new Request(p, { credentials: "include" }))
            .catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from earlier versions so we don't accumulate.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GETs — POST/PATCH/DELETE go through the outbox client.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Skip cross-origin and dev/HMR requests entirely.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/webpack-hmr")) return;
  if (url.pathname.startsWith("/__nextjs")) return;

  // Static asset: cache-first. Hashed filenames make stale cache safe.
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/fonts/") ||
    /^\/favicon\.[^/]+$/.test(url.pathname) ||
    /\.(?:png|jpg|jpeg|svg|webp|woff2?|ttf|ico)$/.test(url.pathname)
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Never intercept API calls — the outbox + bootstrap snapshot are the
  // sanctioned offline paths.
  if (url.pathname.startsWith("/api/")) return;

  // App page navigations: network-first with cache fallback.
  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) {
    event.respondWith(networkFirst(req, PAGES_CACHE));
    return;
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => undefined);
    return res;
  } catch (err) {
    // If we got nothing cached AND the network is dead, return a useful
    // placeholder rather than a generic browser error page.
    return new Response("offline", { status: 503, statusText: "Offline" });
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => undefined);
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Last-ditch fallback to /sales — this is the page we've definitely
    // pre-cached on install, and it's a reasonable landing for a POS.
    const fallback = await cache.match("/sales");
    if (fallback) return fallback;
    return new Response("offline", { status: 503, statusText: "Offline" });
  }
}
