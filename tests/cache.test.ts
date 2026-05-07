import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cacheBustPrefix,
  cacheBustTenant,
  cacheGet,
  cacheRemember,
  cacheSet,
  tenantKey,
} from "@/lib/cache";
import { redis } from "@/lib/redis";

// These tests require a live Redis and silently pass when REDIS_URL isn't
// set (the cache layer no-ops in that case, so there is nothing to verify).
const SKIP = !redis;
const desc = SKIP ? describe.skip : describe;

const TENANT_A = "00000000-0000-0000-0000-00000000000a";
const TENANT_B = "00000000-0000-0000-0000-00000000000b";

desc("cache key isolation between tenants", () => {
  beforeAll(async () => {
    await cacheBustTenant(TENANT_A);
    await cacheBustTenant(TENANT_B);
  });

  beforeEach(async () => {
    await cacheBustTenant(TENANT_A);
    await cacheBustTenant(TENANT_B);
  });

  afterAll(async () => {
    await cacheBustTenant(TENANT_A);
    await cacheBustTenant(TENANT_B);
    await redis?.quit();
  });

  it("does not share entries across tenants", async () => {
    await cacheSet(tenantKey(TENANT_A, "settings"), { shopName: "متجر أ" }, 30);
    const fromA = await cacheGet<{ shopName: string }>(tenantKey(TENANT_A, "settings"));
    const fromB = await cacheGet<{ shopName: string }>(tenantKey(TENANT_B, "settings"));
    expect(fromA?.shopName).toBe("متجر أ");
    expect(fromB).toBeNull();
  });

  it("cacheBustTenant only clears the targeted tenant", async () => {
    await cacheSet(tenantKey(TENANT_A, "settings"), { v: "a" }, 30);
    await cacheSet(tenantKey(TENANT_A, "products"), { v: "a-products" }, 30);
    await cacheSet(tenantKey(TENANT_B, "settings"), { v: "b" }, 30);

    await cacheBustTenant(TENANT_A);

    expect(await cacheGet(tenantKey(TENANT_A, "settings"))).toBeNull();
    expect(await cacheGet(tenantKey(TENANT_A, "products"))).toBeNull();
    expect(await cacheGet<{ v: string }>(tenantKey(TENANT_B, "settings"))).toEqual({
      v: "b",
    });
  });

  it("refuses to bust on a too-short prefix", async () => {
    await cacheSet(tenantKey(TENANT_A, "guard"), { v: 1 }, 30);
    // Anything shorter than the namespace prefix should be a no-op so a typo
    // can't accidentally walk the entire keyspace.
    await cacheBustPrefix("m");
    expect(await cacheGet<{ v: number }>(tenantKey(TENANT_A, "guard"))).toEqual({
      v: 1,
    });
  });

  it("cacheRemember stores the loader result and serves subsequent reads from cache", async () => {
    let loaded = 0;
    const loader = async () => {
      loaded += 1;
      return { hits: loaded };
    };
    const key = tenantKey(TENANT_A, "remember");
    const first = await cacheRemember(key, 30, loader);
    const second = await cacheRemember(key, 30, loader);
    expect(first.hits).toBe(1);
    expect(second.hits).toBe(1); // served from cache, loader not called again
    expect(loaded).toBe(1);
  });
});
