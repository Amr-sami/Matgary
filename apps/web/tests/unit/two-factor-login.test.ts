/**
 * Doc 14 C7 / decision D3-b / security M1 — the native 2FA login step.
 *
 * POST /api/v1/auth/login stops at the password for an account with TOTP on
 * and hands out a one-shot challenge; POST /api/v1/auth/2fa/verify trades the
 * challenge plus a code for the ordinary session. Everything around the two
 * handlers is faked — Postgres (one user row), Redis (an in-memory map with
 * real TTLs), the rate limiter, tenant resolution, the session minter — so
 * the assertions are about the routes' own contract:
 *
 *   - a challenge exists only AFTER a correct password (a wrong one is the
 *     same 401 INVALID_CREDENTIALS as before, and nothing is written);
 *   - a valid TOTP for the stored secret redeems it for tokens, and the
 *     session minter is called with the challenged user;
 *   - a wrong code is 401 INVALID_CODE with a live attemptsLeft that counts
 *     down; the 5th wrong code kills the challenge;
 *   - a redeemed challenge cannot be redeemed twice;
 *   - a challenge older than its TTL is 401 CHALLENGE_EXPIRED;
 *   - a recovery code works once and is struck from the list;
 *   - an access token is NOT a challenge (audience), a forged one is not one
 *     either (signature).
 *
 * The TOTP is generated here with the same RFC 6238 arithmetic lib/totp.ts
 * verifies against (the lib exposes no generator on purpose), and the test
 * checks its own generator against verifyTotp before relying on it.
 */
import { createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

process.env.AUTH_SECRET ??= "two-factor-login-test-secret";

const C = vi.hoisted(() => ({
  USER: "22222222-2222-4222-8222-222222222222",
  TENANT: "11111111-1111-4111-8111-111111111111",
  EMAIL: "owner@example.com",
  PASSWORD: "correct horse battery",
  // 20 random bytes, base32 — the shape generateTotpSecret() produces.
  SECRET: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  RECOVERY: "ab12c-3d4e5",
}));

// ─── fakes ───────────────────────────────────────────────────────────────────

/** The one users row, mutable per test. */
const state = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    email: string;
    name: string | null;
    passwordHash: string;
    totpSecret: string | null;
    totpEnabledAt: Date | null;
    recoveryCodesHash: string[] | null;
  },
  updates: [] as Array<Record<string, unknown>>,
}));

/**
 * A drizzle-shaped chain: every builder method returns the chain, and
 * awaiting it yields the rows. Only `users` is ever queried here, so the
 * WHERE is not interpreted — `state.user` is the whole table.
 */
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "update"]) {
    chain[m] = () => chain;
  }
  chain.set = (values: Record<string, unknown>) => {
    state.updates.push(values);
    if (state.user && "recoveryCodesHash" in values) {
      state.user.recoveryCodesHash = values.recoveryCodesHash as string[];
    }
    return chain;
  };
  chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(state.user ? [state.user] : []).then(resolve, reject);
  return { db: chain };
});

/** Redis, as lib/cache sees it: JSON values with a real (Date-based) TTL. */
const store = vi.hoisted(() => new Map<string, { value: string; expiresAt: number }>());
vi.mock("@/lib/cache", () => ({
  globalKey: (...parts: string[]) => ["test", "g", ...parts].join(":"),
  cacheGet: vi.fn(async (key: string) => {
    const hit = store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return JSON.parse(hit.value);
  }),
  cacheSet: vi.fn(async (key: string, value: unknown, ttlSec: number) => {
    store.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttlSec * 1000 });
  }),
  cacheDel: vi.fn(async (...keys: string[]) => {
    for (const k of keys) store.delete(k);
  }),
}));
vi.mock("@/lib/redis", () => ({ redis: null, isCacheEnabled: () => true }));

vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async () => ({ ok: true, count: 0, resetAt: 0 })),
  rateLimitConsume: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth", () => ({
  normalizeIdentifier: (s: string) => s.trim().toLowerCase(),
  resolveTenantContext: vi.fn(async () => ({ tenantId: C.TENANT })),
}));

vi.mock("@/lib/api/native-session", () => ({
  mintNativeSession: vi.fn(async (user: { id: string; email: string }) => ({
    ok: true,
    body: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
      user: { id: user.id, email: user.email },
      deviceId: "device-1",
    },
  })),
}));

vi.mock("@/lib/request-ip", () => ({ clientIp: () => "203.0.113.7" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { POST as login } from "@/app/api/v1/auth/login/route";
import { POST as verify } from "@/app/api/v1/auth/2fa/verify/route";
import { cacheSet } from "@/lib/cache";
import { mintNativeSession } from "@/lib/api/native-session";
import { CHALLENGE_MAX_ATTEMPTS } from "@/lib/api/native-login";
import { CHALLENGE_TTL_SEC, signAccessToken } from "@/lib/api/native-token";
import { verifyTotp } from "@/lib/totp";

// ─── TOTP generator (RFC 6238, same parameters as lib/totp.ts) ───────────────

function base32Decode(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpNow(secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const counter = Math.floor(nowSec / 30);
  const ctr = Buffer.alloc(8);
  ctr.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  ctr.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac("sha1", base32Decode(secret)).update(ctr).digest();
  const o = h[h.length - 1]! & 0x0f;
  const bin =
    ((h[o]! & 0x7f) << 24) | ((h[o + 1]! & 0xff) << 16) | ((h[o + 2]! & 0xff) << 8) | (h[o + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** A 6-digit string that is NOT valid in the ±1 window right now. */
function wrongCode(): string {
  const now = Math.floor(Date.now() / 1000);
  const live = new Set([totpNow(C.SECRET, now - 30), totpNow(C.SECRET, now), totpNow(C.SECRET, now + 30)]);
  for (let n = 0; n < 1_000_000; n++) {
    const s = String(n).padStart(6, "0");
    if (!live.has(s)) return s;
  }
  throw new Error("unreachable");
}

// ─── harness ─────────────────────────────────────────────────────────────────

const PASSWORD_HASH = bcrypt.hashSync(C.PASSWORD, 4);
const RECOVERY_HASH = bcrypt.hashSync(C.RECOVERY, 4);

function post(handler: (req: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request("http://localhost/api/v1/auth/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ).then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> }));
}

const loginWith = (password: string) =>
  post(login, { identifier: C.EMAIL, password, platform: "ios", installId: "install-1" });

const verifyWith = (challengeToken: unknown, code: string) =>
  post(verify, { challengeToken, code, device: { name: "iPhone", platform: "ios", installId: "install-1" } });

/** Correct password → the challenge the 409 carries. */
async function challenge(): Promise<string> {
  const r = await loginWith(C.PASSWORD);
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("TOTP_REQUIRED");
  expect(typeof r.json.challengeToken).toBe("string");
  return r.json.challengeToken as string;
}

beforeEach(() => {
  store.clear();
  state.updates = [];
  state.user = {
    id: C.USER,
    email: C.EMAIL,
    name: "Owner",
    passwordHash: PASSWORD_HASH,
    totpSecret: C.SECRET,
    totpEnabledAt: new Date("2026-01-01T00:00:00Z"),
    recoveryCodesHash: [RECOVERY_HASH],
  };
  (mintNativeSession as Mock).mockClear();
  (cacheSet as Mock).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the generator agrees with lib/totp.ts", () => {
  it("verifyTotp accepts what totpNow produces", () => {
    expect(verifyTotp(totpNow(C.SECRET), C.SECRET)).toBe(true);
    expect(verifyTotp(wrongCode(), C.SECRET)).toBe(false);
  });
});

describe("POST /api/v1/auth/login with 2FA on", () => {
  it("a wrong password is INVALID_CREDENTIALS and issues no challenge", async () => {
    const r = await loginWith("not it");
    expect(r).toEqual({ status: 401, json: { error: "INVALID_CREDENTIALS" } });
    expect(store.size).toBe(0);
    expect(cacheSet).not.toHaveBeenCalled();
    expect(mintNativeSession).not.toHaveBeenCalled();
  });

  it("a correct password is 409 TOTP_REQUIRED with a challenge and NO session", async () => {
    await challenge();
    expect(mintNativeSession).not.toHaveBeenCalled();
    // One record, the token's own TTL.
    expect(store.size).toBe(1);
    expect(cacheSet).toHaveBeenCalledWith(expect.any(String), { userId: C.USER, attempts: 0 }, CHALLENGE_TTL_SEC);
  });

  it("2FA off: the password alone signs in, as before", async () => {
    state.user!.totpEnabledAt = null;
    const r = await loginWith(C.PASSWORD);
    expect(r.status).toBe(200);
    expect(r.json.accessToken).toBe("access-token");
    expect(store.size).toBe(0);
  });
});

describe("POST /api/v1/auth/2fa/verify", () => {
  it("a valid TOTP redeems the challenge for the login response", async () => {
    const token = await challenge();
    const r = await verifyWith(token, totpNow(C.SECRET));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ accessToken: "access-token", refreshToken: "refresh-token" });
    expect(mintNativeSession).toHaveBeenCalledTimes(1);
    expect(mintNativeSession).toHaveBeenCalledWith(
      { id: C.USER, email: C.EMAIL, name: "Owner" },
      { deviceName: "iPhone", platform: "ios", appVersion: undefined, installId: "install-1" },
    );
  });

  it("a redeemed challenge is spent: the second use is CHALLENGE_EXPIRED", async () => {
    const token = await challenge();
    expect((await verifyWith(token, totpNow(C.SECRET))).status).toBe(200);
    const again = await verifyWith(token, totpNow(C.SECRET));
    expect(again).toEqual({ status: 401, json: { error: "CHALLENGE_EXPIRED" } });
    expect(mintNativeSession).toHaveBeenCalledTimes(1);
  });

  it("a wrong code is INVALID_CODE with attemptsLeft counting down, and the 5th kills the challenge", async () => {
    const token = await challenge();
    const bad = wrongCode();
    for (let i = 1; i < CHALLENGE_MAX_ATTEMPTS; i++) {
      const r = await verifyWith(token, bad);
      expect(r).toEqual({ status: 401, json: { error: "INVALID_CODE", attemptsLeft: CHALLENGE_MAX_ATTEMPTS - i } });
    }
    // Last allowed attempt: still reported as INVALID_CODE, but with 0 left…
    expect(await verifyWith(token, bad)).toEqual({
      status: 401,
      json: { error: "INVALID_CODE", attemptsLeft: 0 },
    });
    expect(store.size).toBe(0);
    // …and the RIGHT code is now too late.
    expect(await verifyWith(token, totpNow(C.SECRET))).toEqual({
      status: 401,
      json: { error: "CHALLENGE_EXPIRED" },
    });
    expect(mintNativeSession).not.toHaveBeenCalled();
  });

  it("a wrong code does not restart the challenge's TTL", async () => {
    const token = await challenge();
    const [key, before] = [...store.entries()][0]!;
    await verifyWith(token, wrongCode());
    const after = store.get(key)!;
    expect(after.expiresAt).toBeLessThanOrEqual(before.expiresAt);
    expect(JSON.parse(after.value)).toEqual({ userId: C.USER, attempts: 1 });
  });

  it("a challenge past its TTL is CHALLENGE_EXPIRED even with the right code", async () => {
    const token = await challenge();
    // Only the clock — bcrypt's async compare schedules real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (CHALLENGE_TTL_SEC + 60) * 1000);
    const r = await verifyWith(token, totpNow(C.SECRET));
    expect(r).toEqual({ status: 401, json: { error: "CHALLENGE_EXPIRED" } });
    expect(mintNativeSession).not.toHaveBeenCalled();
  });

  it("a recovery code redeems the challenge and is struck from the list", async () => {
    const token = await challenge();
    const r = await verifyWith(token, C.RECOVERY.toUpperCase());
    expect(r.status).toBe(200);
    expect(state.user!.recoveryCodesHash).toEqual([]);
    expect(state.updates).toEqual([{ recoveryCodesHash: [] }]);
    // Single-use: the same code on a fresh challenge is now just a wrong code.
    const second = await verifyWith(await challenge(), C.RECOVERY);
    expect(second.json).toMatchObject({ error: "INVALID_CODE" });
  });

  it("2FA switched off between password and code: the challenge is void, login now works alone", async () => {
    const token = await challenge();
    state.user!.totpEnabledAt = null;
    state.user!.totpSecret = null;
    expect(await verifyWith(token, "000000")).toEqual({ status: 401, json: { error: "CHALLENGE_EXPIRED" } });
    expect(store.size).toBe(0);
    expect((await loginWith(C.PASSWORD)).status).toBe(200);
  });

  it("an access token is not a challenge, and neither is garbage", async () => {
    const access = await signAccessToken({
      sub: C.USER,
      tenantId: C.TENANT,
      role: "owner",
      permissions: [],
      tv: 0,
      did: "d",
      susp: null,
      mcp: false,
      sub_ok: true,
    });
    expect(await verifyWith(access, totpNow(C.SECRET))).toEqual({
      status: 401,
      json: { error: "CHALLENGE_EXPIRED" },
    });
    expect(await verifyWith("not.a.token-at-all", totpNow(C.SECRET))).toEqual({
      status: 401,
      json: { error: "CHALLENGE_EXPIRED" },
    });
    expect(await verifyWith(undefined, "123456")).toEqual({ status: 400, json: { error: "INVALID_BODY" } });
  });
});
