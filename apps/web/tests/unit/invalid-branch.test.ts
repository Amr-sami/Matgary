/**
 * Doc 14 §5.3 / 1.0.1 — `X-Branch-Id` is honoured or refused, never
 * substituted. Before this, an unknown or non-allowed header fell through to
 * the primary branch and the request answered 200 with that branch's rows,
 * labelled as the one the client asked for (verified with a zero UUID).
 *
 * The header is the native transport; the `mg.branch` cookie is the web's.
 * Every collaborator is faked (next/headers, the DB, the allow-list cache) so
 * the assertions are about branch-context's own contract:
 *   - header not a UUID / not on the allow-list → INVALID_BRANCH, and no
 *     branch query runs at all (the miss is decided from the allow-list);
 *   - header on the allow-list but inactive → INVALID_BRANCH, no fallback;
 *   - header on the allow-list and active → that branch;
 *   - no header → primary fallback, as before;
 *   - cookie path unchanged: a bad cookie still falls back to primary;
 *   - resolveActiveBranch (the legacy view) reports the miss as null;
 *   - resolveBranchFilter with `?branchId` omitted answers the miss instead
 *     of widening to "all branches".
 */
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const C = vi.hoisted(() => ({
  TENANT: "11111111-1111-4111-8111-111111111111",
  USER: "22222222-2222-4222-8222-222222222222",
  PRIMARY: "33333333-3333-4333-8333-333333333333",
  SECOND: "44444444-4444-4444-8444-444444444444",
  FOREIGN: "00000000-0000-0000-0000-000000000000",
  BAD: "not-a-uuid",
}));

// ─── fakes ───────────────────────────────────────────────────────────────────

/** Per-test request shape. */
const req = vi.hoisted(() => ({
  header: null as string | null,
  cookie: null as string | null,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () =>
    new Headers(req.header === null ? {} : { "x-branch-id": req.header }),
  ),
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "mg.branch" && req.cookie !== null ? { value: req.cookie } : undefined,
  })),
}));

/**
 * A drizzle-shaped tx: every select resolves the next scripted result and
 * records which table it read, so a test can assert that a refused header
 * never reached the branches table.
 */
const fake = vi.hoisted(() => {
  const state = {
    results: [] as unknown[][],
    reads: [] as string[],
  };
  const builder = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.from = (table: unknown) => {
      state.reads.push(getTableName(table as Parameters<typeof getTableName>[0]));
      return b;
    };
    b.where = chain;
    b.limit = chain;
    b.orderBy = chain;
    b.then = (
      resolve: (v: unknown) => void,
      reject: (e: unknown) => void,
    ) => {
      const next = state.results.shift();
      if (!next) {
        reject(new Error(`unexpected query #${state.reads.length} on ${state.reads.at(-1)}`));
        return;
      }
      resolve(next);
    };
    return b;
  };
  const tx = { select: () => builder() };
  return { state, tx };
});

vi.mock("@/lib/db", () => ({
  db: fake.tx,
  withTenant: vi.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx)),
}));

vi.mock("@/lib/cache", () => ({
  globalKey: (...parts: string[]) => parts.join(":"),
  cacheRemember: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  cacheDel: vi.fn(async () => undefined),
}));

vi.mock("@/lib/observability/tracing", () => ({
  withSpan: vi.fn(async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn()),
}));

import {
  resolveActiveBranch,
  resolveActiveBranchResult,
  resolveBranchFilter,
} from "@/lib/api/branch-context";

const owner = { tenantId: C.TENANT, userId: C.USER, role: "owner" };
const staff = { tenantId: C.TENANT, userId: C.USER, role: "staff" };

const allowList = [{ id: C.PRIMARY }, { id: C.SECOND }];
const primaryRow = { id: C.PRIMARY, name: "الفرع الرئيسي", isPrimary: true };
const secondRow = { id: C.SECOND, name: "فرع ثانٍ", isPrimary: false };

function request(shape: { header?: string; cookie?: string }, ...results: unknown[][]) {
  req.header = shape.header ?? null;
  req.cookie = shape.cookie ?? null;
  fake.state.results = results;
  fake.state.reads = [];
}

beforeEach(() => {
  req.header = null;
  req.cookie = null;
  fake.state.results = [];
  fake.state.reads = [];
});

// ─── header path (native) ────────────────────────────────────────────────────

describe("X-Branch-Id — refused, never substituted", () => {
  it("a zero UUID that is not on the allow-list → 400 INVALID_BRANCH, no branch lookup", async () => {
    request({ header: C.FOREIGN }, allowList);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toEqual({ ok: false, status: 400, error: "INVALID_BRANCH", branchId: C.FOREIGN });
    // Only the allow-list was read — no lookup, and no primary fallback.
    expect(fake.state.reads).toEqual(["branches"]);
  });

  it("a non-UUID header → 400 INVALID_BRANCH", async () => {
    request({ header: C.BAD }, allowList);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toMatchObject({ ok: false, status: 400, error: "INVALID_BRANCH", branchId: C.BAD });
    expect(fake.state.reads).toEqual(["branches"]);
  });

  it("staff: a header for a branch other than their own → 400 INVALID_BRANCH", async () => {
    // Staff allow-list comes from tenant_members on the plain client.
    request({ header: C.SECOND }, [{ branchId: C.PRIMARY }]);
    const r = await resolveActiveBranchResult(staff);
    expect(r).toMatchObject({ ok: false, status: 400, error: "INVALID_BRANCH", branchId: C.SECOND });
    expect(fake.state.reads).toEqual(["tenant_members"]);
  });

  it("an allowed but inactive branch → 400 INVALID_BRANCH, not the primary", async () => {
    // Lookup with isActive=true finds nothing; the fallback query must not run.
    request({ header: C.SECOND }, allowList, []);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toMatchObject({ ok: false, status: 400, error: "INVALID_BRANCH", branchId: C.SECOND });
    expect(fake.state.reads).toEqual(["branches", "branches"]);
  });

  it("an allowed, active branch is served", async () => {
    request({ header: C.SECOND }, allowList, [secondRow]);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toEqual({
      ok: true,
      branch: { branchId: C.SECOND, branchName: "فرع ثانٍ", isPrimary: false, allowedBranchIds: [C.PRIMARY, C.SECOND] },
    });
  });

  it("the header wins over a cookie that names another branch", async () => {
    request({ header: C.SECOND, cookie: C.PRIMARY }, allowList, [secondRow]);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toMatchObject({ ok: true, branch: { branchId: C.SECOND } });
  });

  it("no header → primary fallback, as before", async () => {
    request({}, allowList, [primaryRow]);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toMatchObject({ ok: true, branch: { branchId: C.PRIMARY, isPrimary: true } });
  });

  it("resolveActiveBranch (legacy view) reports the refusal as null", async () => {
    request({ header: C.FOREIGN }, allowList);
    expect(await resolveActiveBranch(owner)).toBeNull();
  });
});

// ─── cookie path (web) — unchanged ───────────────────────────────────────────

describe("mg.branch cookie — the web keeps its fallback", () => {
  it("a tampered cookie falls through to the primary branch", async () => {
    // Not on the allow-list: no lookup, straight to the fallback query.
    request({ cookie: C.FOREIGN }, allowList, [primaryRow]);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toMatchObject({ ok: true, branch: { branchId: C.PRIMARY } });
    expect(fake.state.reads).toEqual(["branches", "branches"]);
  });

  it("a non-UUID cookie falls through to the primary branch", async () => {
    request({ cookie: C.BAD }, allowList, [primaryRow]);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toMatchObject({ ok: true, branch: { branchId: C.PRIMARY } });
  });

  it("a cookie for an allowed but inactive branch still falls back", async () => {
    request({ cookie: C.SECOND }, allowList, [], [primaryRow]);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toMatchObject({ ok: true, branch: { branchId: C.PRIMARY } });
    expect(fake.state.reads).toEqual(["branches", "branches", "branches"]);
  });

  it("a valid cookie is honoured", async () => {
    request({ cookie: C.SECOND }, allowList, [secondRow]);
    const r = await resolveActiveBranchResult(owner);
    expect(r).toMatchObject({ ok: true, branch: { branchId: C.SECOND } });
  });
});

// ─── no branch at all ────────────────────────────────────────────────────────

describe("no reachable branch", () => {
  it("an empty allow-list → 403 NO_BRANCH_ACCESS (header or not)", async () => {
    request({ header: C.PRIMARY }, [{ branchId: null }]);
    expect(await resolveActiveBranchResult(staff)).toEqual({ ok: false, status: 403, error: "NO_BRANCH_ACCESS" });
    request({}, [{ branchId: null }]);
    expect(await resolveActiveBranchResult(staff)).toEqual({ ok: false, status: 403, error: "NO_BRANCH_ACCESS" });
  });
});

// ─── list endpoints ──────────────────────────────────────────────────────────

describe("resolveBranchFilter with ?branchId omitted", () => {
  it("passes an INVALID_BRANCH header through as a 400 instead of widening to all branches", async () => {
    request({ header: C.FOREIGN }, allowList);
    const r = await resolveBranchFilter(owner, null);
    expect(r).toEqual({ ok: false, status: 400, error: "INVALID_BRANCH" });
  });

  it("answers 403 NO_BRANCH_ACCESS for an empty allow-list instead of branchId: null", async () => {
    request({}, [{ branchId: null }]);
    const r = await resolveBranchFilter(staff, null);
    expect(r).toEqual({ ok: false, status: 403, error: "NO_BRANCH_ACCESS" });
  });

  it("still resolves the active branch on a good request", async () => {
    request({ header: C.SECOND }, allowList, [secondRow]);
    const r = await resolveBranchFilter(owner, null);
    expect(r).toEqual({ ok: true, branchId: C.SECOND });
  });

  it("an explicit ?branchId keeps its own FORBIDDEN_BRANCH contract", async () => {
    request({}, allowList);
    const r = await resolveBranchFilter(owner, C.FOREIGN);
    expect(r).toEqual({ ok: false, status: 403, error: "FORBIDDEN_BRANCH" });
  });
});
