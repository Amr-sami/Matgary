/**
 * Doc 14 §3.1 C6 — the client-IP helper behind every per-IP rate limit and
 * the /admin allowlist.
 *
 * The bug it replaces: `x-forwarded-for.split(",")[0]` trusted the FIRST hop,
 * which is whatever the client typed. These tests pin the trust order —
 * cf-connecting-ip only under TRUST_CLOUDFLARE=1, then the LAST forwarded hop
 * (the one the reverse proxy appended), then x-real-ip, then the sentinel.
 * Pure functions — no DB.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type IpEnv,
  UNKNOWN_IP,
  clientIp,
  clientIpOrNull,
  lastForwardedHop,
  resetCloudflareWarningForTests,
  trustCloudflare,
} from "@/lib/request-ip";

const h = (init: Record<string, string>) => new Headers(init);
const OFF: IpEnv = {};
const CF: IpEnv = { TRUST_CLOUDFLARE: "1" };

describe("lastForwardedHop", () => {
  it("returns the LAST hop, not the client-controlled first one", () => {
    expect(lastForwardedHop("1.1.1.1, 10.0.0.5, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("trims whitespace and skips trailing empty hops", () => {
    expect(lastForwardedHop("203.0.113.9 ,  ")).toBe("203.0.113.9");
    expect(lastForwardedHop(" 203.0.113.9")).toBe("203.0.113.9");
  });

  it("is null for a missing or all-blank header", () => {
    expect(lastForwardedHop(null)).toBeNull();
    expect(lastForwardedHop(undefined)).toBeNull();
    expect(lastForwardedHop("")).toBeNull();
    expect(lastForwardedHop(" , ,")).toBeNull();
  });
});

describe("clientIp — trust order without Cloudflare", () => {
  it("a spoofed first hop cannot pick the rate-limit key: the proxy's hop wins", () => {
    const src = h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" });
    expect(clientIp(src, OFF)).toBe("203.0.113.9");
  });

  it("ignores cf-connecting-ip when TRUST_CLOUDFLARE is unset (a direct hit could forge it)", () => {
    const src = h({
      "cf-connecting-ip": "6.6.6.6",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(clientIp(src, OFF)).toBe("203.0.113.9");
    expect(clientIp(src, { TRUST_CLOUDFLARE: "0" })).toBe("203.0.113.9");
    expect(clientIp(src, { TRUST_CLOUDFLARE: "true" })).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent or blank", () => {
    expect(clientIp(h({ "x-real-ip": " 198.51.100.4 " }), OFF)).toBe("198.51.100.4");
    expect(
      clientIp(h({ "x-forwarded-for": " , ", "x-real-ip": "198.51.100.4" }), OFF),
    ).toBe("198.51.100.4");
  });

  it("returns the sentinel when no header carries an address", () => {
    expect(clientIp(h({}), OFF)).toBe(UNKNOWN_IP);
    expect(clientIp(h({ "x-forwarded-for": "", "x-real-ip": "  " }), OFF)).toBe(UNKNOWN_IP);
  });
});

describe("clientIp — TRUST_CLOUDFLARE=1", () => {
  it("prefers cf-connecting-ip over both proxy headers", () => {
    const src = h({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "6.6.6.6, 172.16.0.2",
      "x-real-ip": "172.16.0.2",
    });
    expect(clientIp(src, CF)).toBe("203.0.113.9");
  });

  it("still falls through to the forwarded hop when Cloudflare's header is missing or blank", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.9" }), CF)).toBe("203.0.113.9");
    expect(
      clientIp(h({ "cf-connecting-ip": "  ", "x-forwarded-for": "203.0.113.9" }), CF),
    ).toBe("203.0.113.9");
  });

  it("trustCloudflare reads only the exact string \"1\"", () => {
    expect(trustCloudflare({ TRUST_CLOUDFLARE: "1" })).toBe(true);
    expect(trustCloudflare({ TRUST_CLOUDFLARE: "yes" })).toBe(false);
    expect(trustCloudflare({})).toBe(false);
  });
});

describe("clientIpOrNull and the source shapes", () => {
  it("returns null (not the sentinel) so audit rows keep a NULL ip", () => {
    expect(clientIpOrNull(h({}), OFF)).toBeNull();
    expect(clientIpOrNull(h({ "x-real-ip": "198.51.100.4" }), OFF)).toBe("198.51.100.4");
  });

  it("accepts a Request as well as a bare Headers object", () => {
    const req = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
    });
    expect(clientIp(req, OFF)).toBe("203.0.113.9");
    expect(clientIp(req.headers, OFF)).toBe("203.0.113.9");
  });

  it("reads process.env when no env is passed", () => {
    const prev = process.env.TRUST_CLOUDFLARE;
    const src = h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6" });
    try {
      delete process.env.TRUST_CLOUDFLARE;
      expect(clientIp(src)).toBe("6.6.6.6");
      process.env.TRUST_CLOUDFLARE = "1";
      expect(clientIp(src)).toBe("203.0.113.9");
    } finally {
      if (prev === undefined) delete process.env.TRUST_CLOUDFLARE;
      else process.env.TRUST_CLOUDFLARE = prev;
    }
  });
});

describe("the one-time TRUST_CLOUDFLARE warning", () => {
  it("warns once per process when cf-connecting-ip arrives untrusted, never when trusted or absent", () => {
    resetCloudflareWarningForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const behindCloudflare = h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6" });
      // Untrusted: the header is ignored (last XFF hop wins) and ops hear about it once.
      expect(clientIp(behindCloudflare, OFF)).toBe("6.6.6.6");
      expect(clientIp(behindCloudflare, OFF)).toBe("6.6.6.6");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("TRUST_CLOUDFLARE is unset");
      // Trusted: nothing to warn about.
      resetCloudflareWarningForTests();
      expect(clientIp(behindCloudflare, CF)).toBe("203.0.113.9");
      expect(warn).toHaveBeenCalledTimes(1);
      // No Cloudflare header at all: nothing to warn about either.
      expect(clientIp(h({ "x-real-ip": "198.51.100.4" }), OFF)).toBe("198.51.100.4");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
