/**
 * Native intent handler — universal links (iOS) / app links (Android).
 *
 * Expo Router calls `redirectSystemPath` with every URL the OS hands the app:
 * the cold-start URL (`initial: true`) and every `Linking` "url" event after
 * that. Whatever string we return is what the router navigates to. The URL
 * arrives raw, so it can be any of:
 *
 *   https://thestoro.com/ar/reset-password?token=…   ← password-reset e-mail
 *   https://thestoro.com/en/login                    ← "open in app" from web
 *   matgary://reset-password?token=…                 ← custom scheme fallback
 *   matgary:///                                      ← home-screen launch (no link)
 *   matgary://expo-development-client/?url=…         ← dev client boot
 *
 * Only the web (http/https) form needs translating: the web app prefixes
 * every pre-login URL with /ar or /en, and the native app has no locale
 * segment in its routes. Custom-scheme URLs are Expo Router's own dialect
 * and are passed through untouched (bar the same locale strip), so a push
 * notification or another feature's `Linking.openURL("matgary://…")` keeps
 * working without this file knowing about it.
 *
 * Constraints, all deliberate:
 *   - No `URL` / `URLSearchParams`: React Native's `URL` polyfill throws on
 *     `.pathname` / `.search`, and Hermes has no native implementation.
 *     Everything below is plain string work.
 *   - The query string is carried verbatim — never decoded and re-encoded —
 *     so a reset token survives byte-for-byte (`reset-password.tsx` reads it
 *     with `useLocalSearchParams`, which decodes once).
 *   - Never throw: Expo Router documents that an exception here can crash the
 *     app at launch. `redirectSystemPath` wraps everything in try/catch and
 *     falls back to the untouched input.
 *   - Zero imports. This module is also unit-tested with plain `node --test`
 *     (see `__tests__/native-intent.test.ts`), which cannot load RN modules.
 *
 * Web → app route map (doc 02 §3.9, mobile-dev-docs/10-universal-links.md):
 *
 *   /{ar|en}/reset-password?token=…  → /reset-password?token=…
 *   /{ar|en}/login                   → /login
 *   /{ar|en}/forgot-password         → /forgot-password
 *   /{ar|en}/signup                  → /signup
 *   /whatsapp                        → /whatsapp
 *   /settings, /settings/*           → same
 *   /team, /team/*                   → same
 *   /, /ar, /en                      → /
 *   anything else                    → /   (the app has no page for it)
 */

const LOCALES: ReadonlySet<string> = new Set(["ar", "en"]);

/** `scheme://` — RFC 3986 scheme grammar, case-insensitive. */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/** Routes that map 1:1 and never carry a query string across. */
const EXACT_ROUTES: ReadonlySet<string> = new Set([
  "/login",
  "/forgot-password",
  "/signup",
  "/whatsapp",
]);

/** Routes whose sub-paths are forwarded as-is (`/settings/digest`, `/team/attendance`). */
const PREFIX_ROUTES: readonly string[] = ["/settings", "/team"];

type Parsed = {
  /** Lower-cased scheme without `://`, or "" for a bare path. */
  scheme: string;
  /** For http(s): the `host[:port]`; for custom schemes: "" (host is part of the path). */
  host: string;
  /** Always starts with "/" and never ends with one (except the root "/"). */
  pathname: string;
  /** "" or "?…" — verbatim, fragment removed. */
  search: string;
};

function isHttp(scheme: string): boolean {
  return scheme === "http" || scheme === "https";
}

/**
 * Split a URL or path into scheme / host / pathname / search without touching
 * the bytes of the query string.
 */
export function parseLink(input: string): Parsed {
  let rest = typeof input === "string" ? input.trim() : "";

  // A fragment is meaningless to the router and could hide a "?" — drop it.
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);

  let scheme = "";
  let host = "";
  const m = SCHEME_RE.exec(rest);
  if (m) {
    scheme = m[1].toLowerCase();
    rest = rest.slice(m[0].length);
    if (isHttp(scheme)) {
      // Host runs to the first "/" or "?" — whichever comes first.
      let end = rest.length;
      for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if (ch === "/" || ch === "?") {
          end = i;
          break;
        }
      }
      host = rest.slice(0, end);
      rest = rest.slice(end);
    }
  }

  const q = rest.indexOf("?");
  const search = q >= 0 ? rest.slice(q) : "";
  let pathname = q >= 0 ? rest.slice(0, q) : rest;

  // Normalise: single leading slash, no duplicate or trailing slashes.
  pathname = "/" + pathname.split("/").filter(Boolean).join("/");

  return { scheme, host, pathname, search };
}

/**
 * Remove a leading `/ar` or `/en` segment. `/arabic` is left alone — the
 * match is on the whole segment, not a prefix.
 */
export function stripLocalePrefix(pathname: string): string {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length > 0 && LOCALES.has(segs[0].toLowerCase())) {
    segs.shift();
  }
  return "/" + segs.join("/");
}

/**
 * Pure mapper: a web URL or web path → the app route to open.
 *
 * Accepts `https://thestoro.com/ar/reset-password?token=x`,
 * `/en/login`, `reset-password?token=x` … and always returns an app path
 * starting with "/". Unknown paths collapse to "/" so a link the app has no
 * screen for lands on the home tab instead of Expo Router's "Unmatched Route".
 */
export function mapWebPathToAppRoute(input: string): string {
  const { pathname, search } = parseLink(input);
  const path = stripLocalePrefix(pathname);
  const lower = path.toLowerCase();

  if (lower === "/") return "/";

  if (lower === "/reset-password") {
    // The token rides in the query string, byte-for-byte.
    return "/reset-password" + search;
  }

  if (EXACT_ROUTES.has(lower)) return lower;

  for (const prefix of PREFIX_ROUTES) {
    if (lower === prefix || lower.startsWith(prefix + "/")) return lower;
  }

  return "/";
}

/**
 * Decide what the router should open for a system-provided URL.
 *
 *   - http(s) or bare path → `mapWebPathToAppRoute`
 *   - any other scheme     → returned unchanged, except that a leading
 *                            `/ar` or `/en` segment is removed so
 *                            `matgary://ar/reset-password?token=x` works too
 */
export function resolveSystemPath(input: string): string {
  const parsed = parseLink(input);

  if (parsed.scheme === "" || isHttp(parsed.scheme)) {
    return mapWebPathToAppRoute(input);
  }

  // Custom scheme (matgary://, com.thestoro.app://, exp://, exp+…://).
  // Rebuild only when a locale segment was actually removed; otherwise hand
  // Expo Router the exact string it gave us.
  const stripped = stripLocalePrefix(parsed.pathname);
  if (stripped === parsed.pathname) return input;

  // Custom schemes have no host of their own — the first segment after
  // `scheme://` is already path. Emit `scheme://segment…` (no leading slash),
  // which is the form Expo Router itself produces from `Linking.createURL`.
  const body = stripped === "/" ? "" : stripped.slice(1);
  return `${parsed.scheme}://${body}${parsed.search}`;
}

/**
 * Expo Router entry point. See `NativeIntent` in expo-router/build/types.d.ts.
 * Must never throw.
 */
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string {
  try {
    return resolveSystemPath(path);
  } catch {
    return path;
  }
}
