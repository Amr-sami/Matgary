/**
 * The one place the client IP is derived from a request.
 *
 * Every per-IP rate limit (login, refresh, signup, forgot/reset, cron, admin
 * login …) and the /admin IP allowlist used to read the FIRST hop of
 * `x-forwarded-for`. That hop is whatever the client typed: one header per
 * request and every limit keyed on it resets. Doc 14 §3.1 C6 / security H1.
 *
 * Resolution order (first non-empty wins):
 *   1. `cf-connecting-ip`   — only when TRUST_CLOUDFLARE=1. Cloudflare sets
 *      it from the TCP peer and overwrites any client-supplied copy, but a
 *      request that reaches the origin WITHOUT passing Cloudflare can forge
 *      it, so only flip the flag on a box whose origin accepts traffic from
 *      Cloudflare's ranges alone.
 *   2. last `x-forwarded-for` hop — the one the reverse proxy in front of the
 *      app appended (`$proxy_add_x_forwarded_for`). Client-supplied hops sit
 *      to the LEFT of it and are ignored.
 *   3. `x-real-ip`          — nginx's `$remote_addr` when it is configured.
 *   4. null                 — a Next.js route handler has no socket access, so
 *      there is no peer address to fall back to; callers that need a string
 *      key get `UNKNOWN_IP` from `clientIp`.
 *
 * Pure and runtime-agnostic (no Node imports) so `lib/admin/middleware.ts`
 * can call it from the edge runtime.
 */

/** Anything with a WHATWG `Headers` — a `Request`, a `NextRequest`, or the
 *  `Headers` object `await headers()` returns in a server action. */
export type IpSource = Headers | { headers: Headers };

/** Sentinel returned by `clientIp` when no header carries an address. */
export const UNKNOWN_IP = "unknown";

/** The one variable the helper reads; `process.env` satisfies it (the index
 *  signature is what lets ProcessEnv and a bare `{}` both type-check). */
export type IpEnv = {
  readonly TRUST_CLOUDFLARE?: string;
  readonly [key: string]: string | undefined;
};

function headersOf(source: IpSource): Headers {
  return source instanceof Headers ? source : source.headers;
}

function nonEmpty(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** True when the deployment has opted into trusting Cloudflare's header. */
export function trustCloudflare(env: IpEnv = process.env): boolean {
  return env.TRUST_CLOUDFLARE === "1";
}

/**
 * A `cf-connecting-ip` header with TRUST_CLOUDFLARE unset almost always means
 * the origin IS behind Cloudflare and the flag was forgotten: the last XFF
 * hop and `x-real-ip` are then Cloudflare edge addresses, every per-IP
 * bucket is shared between visitors (cross-user 429s on login / signup /
 * refresh / cron) and the admin allowlist is checked against the wrong IP.
 * Said once per process — it is a deployment mistake, not a request event —
 * through console so the edge runtime (lib/admin/middleware.ts) can log it
 * too. A direct hit that forges the header on a non-Cloudflare box trips it
 * as well; one line, no harm.
 */
let warnedUntrustedCloudflareHeader = false;
function warnUntrustedCloudflareHeader(): void {
  if (warnedUntrustedCloudflareHeader) return;
  warnedUntrustedCloudflareHeader = true;
  console.warn(
    "[request-ip] cf-connecting-ip is present but TRUST_CLOUDFLARE is unset: " +
      "per-IP rate limits and ADMIN_IP_ALLOWLIST are keyed on Cloudflare edge IPs. " +
      "Set TRUST_CLOUDFLARE=1 on an origin that only Cloudflare can reach.",
  );
}

/** Test seam: forget that the warning was emitted. */
export function resetCloudflareWarningForTests(): void {
  warnedUntrustedCloudflareHeader = false;
}

/** The last hop of an `x-forwarded-for` list, or null when every hop is blank. */
export function lastForwardedHop(xff: string | null | undefined): string | null {
  if (!xff) return null;
  const hops = xff.split(",");
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = nonEmpty(hops[i]);
    if (hop) return hop;
  }
  return null;
}

/**
 * The client IP, or null when no header carries one. Use this where the
 * value is stored (audit logs) and a missing address should stay NULL.
 */
export function clientIpOrNull(
  source: IpSource,
  env: IpEnv = process.env,
): string | null {
  const h = headersOf(source);
  const cf = nonEmpty(h.get("cf-connecting-ip"));
  if (trustCloudflare(env)) {
    if (cf) return cf;
  } else if (cf) {
    warnUntrustedCloudflareHeader();
  }
  return (
    lastForwardedHop(h.get("x-forwarded-for")) ??
    nonEmpty(h.get("x-real-ip"))
  );
}

/**
 * The client IP as a non-empty string — `UNKNOWN_IP` when nothing is set.
 * Use this for rate-limit keys and the admin allowlist, where a key is
 * always needed.
 */
export function clientIp(
  source: IpSource,
  env: IpEnv = process.env,
): string {
  return clientIpOrNull(source, env) ?? UNKNOWN_IP;
}
