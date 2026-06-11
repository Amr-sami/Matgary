// Request guard for /admin/*. Used by middleware.ts to enforce IP allowlist
// + the hard-404 rule before any route handler runs.

import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE } from "./cookie";

const ALLOWLIST = parseAllowlist(process.env.ADMIN_IP_ALLOWLIST);
const BYPASS_USER_HEADER_TAG = process.env.ADMIN_IP_ALLOWLIST_BYPASS_USER || null;

/** Returns null when the request is allowed to pass; returns a 404 response
 *  when the URL space should pretend not to exist. */
export function gateAdminRequest(req: NextRequest): NextResponse | null {
  const ip = extractIp(req);

  // IP allowlist gate. Empty allowlist = no gate.
  if (ALLOWLIST && ALLOWLIST.length > 0) {
    const allowed = isIpInAllowlist(ip, ALLOWLIST);
    const bypassed = isBypassed(req);
    if (!allowed && !bypassed) {
      return hardNotFound();
    }
  }

  return null;
}

/** Used by the proxy to return 404 for any /admin route except /admin/login
 *  when there's no admin cookie. /admin/login is the only public surface. */
export function isAdminPublicPath(pathname: string): boolean {
  // Keep this list short. The login page + a couple of API auth endpoints.
  // Note: middleware also lets /api/admin/auth/login through because the
  // login flow itself can't carry a cookie yet.
  if (pathname === "/admin/login") return true;
  if (pathname.startsWith("/api/admin/auth/login")) return true;
  // Spec 07 — impersonation handshake + exit run on the tenant origin
  // (with the tenant session, not the admin session). They must pass
  // through this gate even when the admin cookie isn't present.
  if (pathname.startsWith("/api/admin/impersonation/start")) return true;
  if (pathname.startsWith("/api/admin/impersonation/exit")) return true;
  return false;
}

export function hasAdminCookie(req: NextRequest): boolean {
  return !!req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
}

export function hardNotFound(): NextResponse {
  // Identical body + status to what Next.js' standard not-found returns at
  // the edge: just a 404 with a minimal body. Browsers will render the
  // project's not-found page on the client.
  return new NextResponse("Not Found", { status: 404 });
}

// ─── helpers ─────────────────────────────────────────────────────────────

function extractIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  // Next.js exposes the parsed IP for runtime engines that surface it.
  // Fall through to a placeholder so the allowlist still does its job.
  return "unknown";
}

function parseAllowlist(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function isIpInAllowlist(ip: string, list: string[]): boolean {
  for (const entry of list) {
    if (matchEntry(ip, entry)) return true;
  }
  return false;
}

function matchEntry(ip: string, entry: string): boolean {
  // Bare IP literal — exact match.
  if (!entry.includes("/")) return ip === entry;
  // CIDR. Pure IPv4 only for v1; IPv6 / mixed deferred.
  const [base, bitsStr] = entry.split("/");
  const bits = Number(bitsStr);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt == null || baseInt == null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = (v << 8) | n;
  }
  return v >>> 0;
}

function isBypassed(req: NextRequest): boolean {
  // Allow one specific admin to bypass the allowlist. The mechanism here is
  // deliberately humble — a header set in front of the proxy (nginx) keyed
  // to the bypass email. Internal-only knob; documented in .env.example as
  // a lockout-escape hatch.
  if (!BYPASS_USER_HEADER_TAG) return false;
  const tag = req.headers.get("x-admin-bypass");
  return !!tag && tag === BYPASS_USER_HEADER_TAG;
}
