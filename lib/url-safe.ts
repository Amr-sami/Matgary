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
