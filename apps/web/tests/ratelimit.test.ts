import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit } from "@/lib/ratelimit";
import { redis } from "@/lib/redis";

// H10 — pwd.forgot.email bucket. Mirrors the cache test's "skip if Redis
// not configured" pattern; in CI Redis is always reachable so this never
// skips there.
const REDIS_CONFIGURED =
  !!process.env.REDIS_URL && process.env.CACHE_DISABLED !== "1";
const SKIP = !redis;
const desc = SKIP ? describe.skip : describe;
if (SKIP && REDIS_CONFIGURED) {
  throw new Error(
    "[ratelimit.test] REDIS_URL is set but lib/redis returned null — refusing to skip silently.",
  );
}
if (SKIP) {
  console.warn(
    "[ratelimit.test] Skipping — REDIS_URL not configured.",
  );
}

function hashEmail(email: string): string {
  return crypto.createHash("sha256").update(email).digest("hex");
}

async function wipeBucket(scope: string) {
  if (!redis) return;
  // Cache key prefix matches lib/cache.ts: matgary:<env>:<v1>:g:rl:<scope>:*
  const pattern = `matgary:*:rl:${scope}:*`;
  const keys = await redis.keys(pattern);
  if (keys.length) await redis.del(...keys);
}

desc("pwd.forgot.email rate limit (H10)", () => {
  const SCOPE = "pwd.forgot.email";
  const OPTS = { limit: 3, windowSec: 3600 };

  beforeEach(async () => {
    await wipeBucket(SCOPE);
  });

  it("permits exactly 3 attempts per email hash, then blocks the 4th", async () => {
    const id = hashEmail("h10-counter@example.com");
    const a = await rateLimit(SCOPE, id, OPTS);
    const b = await rateLimit(SCOPE, id, OPTS);
    const c = await rateLimit(SCOPE, id, OPTS);
    const d = await rateLimit(SCOPE, id, OPTS);
    expect([a.ok, b.ok, c.ok, d.ok]).toEqual([true, true, true, false]);
  });

  it("isolates budget per email hash — alice cannot exhaust bob's", async () => {
    const alice = hashEmail("h10-alice@example.com");
    const bob = hashEmail("h10-bob@example.com");
    await rateLimit(SCOPE, alice, OPTS);
    await rateLimit(SCOPE, alice, OPTS);
    await rateLimit(SCOPE, alice, OPTS);
    const aliceBlocked = await rateLimit(SCOPE, alice, OPTS);
    const bobStillOk = await rateLimit(SCOPE, bob, OPTS);
    expect(aliceBlocked.ok).toBe(false);
    expect(bobStillOk.ok).toBe(true);
  });

  it("hashes raw input — different case yields different identifier (route is responsible for lowercasing)", async () => {
    // Confirms the production route's lowercase-before-hash is what makes
    // case-collisions share a bucket. The hash itself is case-sensitive.
    expect(hashEmail("Foo@example.com")).not.toBe(hashEmail("foo@example.com"));
  });
});
