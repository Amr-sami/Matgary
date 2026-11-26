/**
 * Digital collections 05 §7 — the /api/collections/* handlers' own contract,
 * with auth, rate limit, activity, the Redis idempotency store and the repo
 * faked (pattern: tests/unit/oversell.test.ts):
 *   - the env gate (403 COLLECTIONS_DISABLED everywhere but `config`);
 *   - required Idempotency-Key, cached replay, cross-id mismatch, a 409 that
 *     is NOT cached;
 *   - zod failures answer 400 INVALID_REQUEST {detail:{path,message}};
 *   - a cashier's GET accounts carries no IBAN; every mask is 06's ASCII
 *     accountMask() of the row;
 *   - the cart route books a wallet sale naming an unknown account (201).
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/errors";
import { accountMask } from "@matgary/domain/collections/normalize";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const BRANCH = "33333333-3333-4333-8333-333333333333";
const CID = "44444444-4444-4444-8444-444444444444";
const CID2 = "55555555-5555-4555-8555-555555555555";
const ACC = "66666666-6666-4666-8666-666666666666";
const PRODUCT = "77777777-7777-4777-8777-777777777777";

// ─── auth: the principal is swappable per test ─────────────────────────────
const who = vi.hoisted(() => ({
  role: "owner" as string | null,
  permissions: [] as string[],
}));

function ctx() {
  return {
    userId: OWNER,
    tenantId: TENANT,
    role: who.role,
    permissions: who.permissions,
    branchId: BRANCH,
    branchName: "Main",
    isPrimaryBranch: true,
    allowedBranchIds: [BRANCH],
  };
}

vi.mock("@/lib/api/auth-helpers", () => {
  const allow = async () => ({ ok: true, ctx: ctx() });
  const enforced = async (perm: string) => {
    const c = ctx();
    if (c.role === "owner" || c.permissions.includes(perm)) return { ok: true, ctx: c };
    const { NextResponse } = await import("next/server");
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  };
  return {
    requireTenantWithBranch: vi.fn(allow),
    requirePermissionWithBranch: vi.fn(allow),
    requirePermissionWithBranchEnforced: vi.fn(enforced),
  };
});

vi.mock("@/lib/api/branch-context", () => ({
  resolveBranchFilter: vi.fn(async (c: { role: string | null }, raw: string | null) =>
    raw === "all"
      ? c.role === "owner"
        ? { ok: true, branchId: null }
        : { ok: false, status: 403, error: "ALL_BRANCHES_OWNER_ONLY" }
      : { ok: true, branchId: raw ?? BRANCH },
  ),
}));

vi.mock("@/lib/api/tenant-rate-limit", () => ({
  checkTenantRateLimit: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/repo/activity", () => ({ logActivity: vi.fn() }));

const idempStore = vi.hoisted(() => new Map<string, { status: number; body: unknown; at: number; fingerprint?: string }>());
vi.mock("@/lib/api/idempotency", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/idempotency")>("@/lib/api/idempotency");
  return {
    ...actual,
    lookupIdempotent: vi.fn(async (tenantId: string, key: string, fingerprint: string) =>
      actual.classifyLookup(idempStore.get(`${tenantId}:${key}`) ?? null, fingerprint),
    ),
    rememberResponse: vi.fn(
      async (tenantId: string, key: string, status: number, body: unknown, fingerprint?: string) => {
        idempStore.set(`${tenantId}:${key}`, { status, body, at: Date.now(), ...(fingerprint ? { fingerprint } : {}) });
      },
    ),
  };
});

// ─── the DB, only for the real accounts repo read (cashier IBAN strip) ─────
const dbRows = vi.hoisted(() => ({ accounts: [] as Record<string, unknown>[] }));
vi.mock("@/lib/db", () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "from", "where", "orderBy", "limit"]) q[m] = () => q;
    (q as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(dbRows.accounts);
    return q;
  };
  return {
    db: {},
    withTenant: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn({ select: () => chain() })),
  };
});

// ─── the collections repo: decisions faked, pure helpers real ──────────────
vi.mock("@/lib/repo/collections", async () => {
  const actual = await vi.importActual<typeof import("@/lib/repo/collections")>("@/lib/repo/collections");
  return {
    ...actual,
    confirmCollection: vi.fn(),
    rejectCollection: vi.fn(),
    reopenCollection: vi.fn(),
    listCollections: vi.fn(async () => ({ data: [], nextCursor: null, counts: { pending: 0, stale: 0 } })),
    getCollectionSettings: vi.fn(async (_t: string, branchId: string) => ({
      branchId,
      collectionsEnabled: false,
      collectionsRequireAccount: true,
      collectionsStaleAfterMinutes: 120,
      collectionsAutoConfirmEnabled: false,
      collectionsStorePayerNames: false,
    })),
  };
});

vi.mock("@/lib/repo/operations", () => ({
  findCartSaleByIdempotencyKey: vi.fn(async () => null),
  recordCartSale: vi.fn(async (_t: string, _lines: unknown, options: Record<string, unknown>) => ({
    invoiceId: String(options.invoiceId ?? "INV-X"),
    saleIds: ["sale-1"],
    lines: [{ productName: "P", quantity: 1, pricePerUnit: 100, lineTotal: 100 }],
    total: 100,
    paymentMethod: options.paymentMethod,
    customerName: null,
    customerPhone: null,
    note: null,
    oversold: [],
    // The real repo books and flags `account_missing` (collections-repo.test.ts).
    collectionStatus: "pending",
    collectionIds: [CID],
  })),
}));

import { GET as listGET } from "@/app/api/collections/route";
import { POST as confirmPOST } from "@/app/api/collections/[id]/confirm/route";
import { POST as rejectPOST } from "@/app/api/collections/[id]/reject/route";
import { POST as reopenPOST } from "@/app/api/collections/[id]/reopen/route";
import { GET as configGET } from "@/app/api/collections/config/route";
import { GET as accountsGET, POST as accountsPOST } from "@/app/api/collections/accounts/route";
import { GET as summaryGET } from "@/app/api/collections/summary/route";
import { POST as cartPOST } from "@/app/api/sales/cart/route";
import { confirmCollection, rejectCollection, toCollectionDTO } from "@/lib/repo/collections";
import { toAccountDTO } from "@/lib/repo/collection-accounts";
import { recordCartSale } from "@/lib/repo/operations";
import type { CollectionAccountRow } from "@/lib/db/schema";

function req(url: string, init: { method?: string; body?: unknown; key?: string | null } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.key) headers["Idempotency-Key"] = init.key;
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function dto(id: string, status = "confirmed") {
  return {
    id,
    status,
    sourceType: "sale",
    method: "wallet",
    amount: 100,
    partNo: 1,
    partsCount: 1,
    invoiceId: "INV-1",
    anchorSaleId: null,
    branchId: BRANCH,
    account: null,
    payerPhoneLast4: null,
    payerReference: null,
    rungAt: new Date().toISOString(),
    recordedBy: null,
    decidedBy: { id: OWNER, name: "Owner" },
    decidedAt: new Date().toISOString(),
    rejectReason: null,
    rejectOutcome: null,
    flags: [],
    isStale: false,
    matchedCredit: null,
    customerPhone: null,
  };
}

function accountRow(over: Partial<CollectionAccountRow> = {}): CollectionAccountRow {
  const now = new Date();
  return {
    id: ACC,
    tenantId: TENANT,
    branchId: null,
    rail: "instapay",
    provider: "cib",
    label: "CIB business",
    holderName: "Amr",
    ipaHandle: "amr.shop@instapay",
    ipaLink: "https://ipn.eg/S/amr.shop/instapay/AbC123",
    accountLast4: "0150",
    isPrepaidCard: false,
    iban: "EG380019000500000000263180002",
    walletMsisdn: null,
    walletOpenedOn: null,
    isDefaultForMobile: false,
    isPosDefault: true,
    autoConfirmEnabled: false,
    reviewThreshold: "5000.00",
    balanceCheckEnabled: true,
    balanceBaseline: "1200.00",
    balanceBaselineAt: now,
    balanceChainBrokenAt: null,
    sortOrder: 0,
    createdByUserId: OWNER,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...over,
  };
}

const savedEnv = process.env.COLLECTIONS_ENABLED;
beforeEach(() => {
  idempStore.clear();
  who.role = "owner";
  who.permissions = [];
  process.env.COLLECTIONS_ENABLED = "on";
  dbRows.accounts = [];
  vi.mocked(confirmCollection).mockReset();
  vi.mocked(rejectCollection).mockReset();
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.COLLECTIONS_ENABLED;
  else process.env.COLLECTIONS_ENABLED = savedEnv;
});

describe("env gate (05 §4.2)", () => {
  it("COLLECTIONS_ENABLED off → 403 COLLECTIONS_DISABLED on list, confirm, accounts, summary", async () => {
    process.env.COLLECTIONS_ENABLED = "off";
    for (const res of [
      await listGET(req("/api/collections")),
      await confirmPOST(req(`/api/collections/${CID}/confirm`, { method: "POST", body: {}, key: "k-off-00001" }), params(CID)),
      await accountsGET(req("/api/collections/accounts")),
      await summaryGET(req("/api/collections/summary")),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "COLLECTIONS_DISABLED" });
    }
    expect(confirmCollection).not.toHaveBeenCalled();
  });

  it("config answers 200 with every feature false while the tenant is not admitted", async () => {
    delete process.env.COLLECTIONS_ENABLED;
    const res = await configGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features: Record<string, boolean>; ingest: unknown; limits: unknown };
    expect(Object.values(body.features).every((v) => v === false)).toBe(true);
    expect(Object.keys(body.features).sort()).toEqual(
      ["collections", "collectionsAutoConfirm", "collectionsAvailable", "collectionsIngest", "collectionsProviders"],
    );
    expect(body.limits).toEqual({ maxParts: 4, reopenDays: 7, noteMaxLength: 280 });
    expect(body.ingest).toBeNull();
  });
});

describe("decision idempotency (05 §4.4)", () => {
  it("confirm without Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED, repo not called", async () => {
    const res = await confirmPOST(req(`/api/collections/${CID}/confirm`, { method: "POST", body: {} }), params(CID));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(confirmCollection).not.toHaveBeenCalled();
  });

  it("a replay of the same key returns the cached body; the repo runs once", async () => {
    vi.mocked(confirmCollection).mockResolvedValue({ dto: dto(CID) as never, replayed: false });
    const a = await confirmPOST(req(`/api/collections/${CID}/confirm`, { method: "POST", body: {}, key: "k-replay-0001" }), params(CID));
    const b = await confirmPOST(req(`/api/collections/${CID}/confirm`, { method: "POST", body: {}, key: "k-replay-0001" }), params(CID));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    expect(confirmCollection).toHaveBeenCalledTimes(1);
  });

  it("the same key on ANOTHER collection id → 409 IDEMPOTENCY_MISMATCH (fingerprint binds op + id)", async () => {
    vi.mocked(confirmCollection).mockResolvedValue({ dto: dto(CID) as never, replayed: false });
    await confirmPOST(req(`/api/collections/${CID}/confirm`, { method: "POST", body: {}, key: "k-cross-00001" }), params(CID));
    const res = await confirmPOST(req(`/api/collections/${CID2}/confirm`, { method: "POST", body: {}, key: "k-cross-00001" }), params(CID2));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "IDEMPOTENCY_MISMATCH" });
    expect(confirmCollection).toHaveBeenCalledTimes(1);
  });

  it("the same key on another OPERATION (reject after confirm) → 409 IDEMPOTENCY_MISMATCH", async () => {
    vi.mocked(confirmCollection).mockResolvedValue({ dto: dto(CID) as never, replayed: false });
    await confirmPOST(req(`/api/collections/${CID}/confirm`, { method: "POST", body: {}, key: "k-op-000001" }), params(CID));
    const res = await rejectPOST(
      req(`/api/collections/${CID}/reject`, { method: "POST", body: {}, key: "k-op-000001" }),
      params(CID),
    );
    expect(res.status).toBe(409);
  });

  it("a 409 is NOT cached: the retry reaches the repo again", async () => {
    vi.mocked(confirmCollection)
      .mockRejectedValueOnce(new DomainError("COLLECTION_NOT_PENDING", 409, { status: "rejected" }))
      .mockResolvedValueOnce({ dto: dto(CID) as never, replayed: false });
    const a = await confirmPOST(req(`/api/collections/${CID}/confirm`, { method: "POST", body: {}, key: "k-409-000001" }), params(CID));
    expect(a.status).toBe(409);
    expect(await a.json()).toMatchObject({ error: "COLLECTION_NOT_PENDING" });
    expect(idempStore.size).toBe(0);
    const b = await confirmPOST(req(`/api/collections/${CID}/confirm`, { method: "POST", body: {}, key: "k-409-000001" }), params(CID));
    expect(b.status).toBe(200);
    expect(confirmCollection).toHaveBeenCalledTimes(2);
  });

  it("a non-uuid id answers 404 COLLECTION_NOT_FOUND (ids cannot be probed)", async () => {
    const res = await confirmPOST(req(`/api/collections/abc/confirm`, { method: "POST", body: {}, key: "k-404-000001" }), params("abc"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "COLLECTION_NOT_FOUND" });
  });

  it("reopen by a staff member → 403 Forbidden before anything else", async () => {
    who.role = "staff";
    who.permissions = ["confirm_collections", "view_collections"];
    const res = await reopenPOST(req(`/api/collections/${CID}/reopen`, { method: "POST", body: {}, key: "k-reopen-0001" }), params(CID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("a staff member without confirm_collections → 403 Forbidden (enforced, not audit mode)", async () => {
    delete process.env.PERMISSION_ENFORCE_WRITES;
    who.role = "staff";
    who.permissions = ["record_sales", "view_collections"];
    const res = await confirmPOST(req(`/api/collections/${CID}/confirm`, { method: "POST", body: {}, key: "k-perm-00001" }), params(CID));
    expect(res.status).toBe(403);
    expect(confirmCollection).not.toHaveBeenCalled();
  });
});

describe("validation → 400 INVALID_REQUEST", () => {
  it("reject with an unknown reason", async () => {
    const res = await rejectPOST(
      req(`/api/collections/${CID}/reject`, { method: "POST", body: { reason: "nope" }, key: "k-zod-000001" }),
      params(CID),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: { path: string; message: string } };
    expect(body.error).toBe("INVALID_REQUEST");
    expect(body.detail.path).toBe("reason");
    expect(rejectCollection).not.toHaveBeenCalled();
  });

  it("reject with a phone that is not Egyptian → 400 INVALID_PHONE", async () => {
    const res = await rejectPOST(
      req(`/api/collections/${CID}/reject`, {
        method: "POST",
        body: { reason: "not_received", outcome: "debt", customerPhone: "12345" },
        key: "k-phone-00001",
      }),
      params(CID),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_PHONE" });
  });

  it("account create with an unknown key (strict) and with rail/provider mismatch", async () => {
    const a = await accountsPOST(
      req("/api/collections/accounts", {
        method: "POST",
        body: { rail: "wallet", provider: "vodafone_cash", label: "VF", walletMsisdn: "01012345678", nope: 1 },
      }),
    );
    expect(a.status).toBe(400);
    expect(await a.json()).toMatchObject({ error: "INVALID_REQUEST" });
    const b = await accountsPOST(
      req("/api/collections/accounts", {
        method: "POST",
        body: { rail: "instapay", provider: "vodafone_cash", label: "x", accountLast4: "1234" },
      }),
    );
    expect(b.status).toBe(400);
    expect(await b.json()).toMatchObject({ error: "PROVIDER_RAIL_MISMATCH" });
  });

  it("list with an unknown status, a bad limit or a bad accountId", async () => {
    const a = await listGET(req("/api/collections?status=pending,bogus"));
    expect(a.status).toBe(400);
    expect(await a.json()).toMatchObject({ error: "INVALID_REQUEST", detail: { path: "status" } });
    const b = await listGET(req("/api/collections?limit=101"));
    expect(b.status).toBe(400);
    const c = await listGET(req("/api/collections?accountId=nope"));
    expect(c.status).toBe(400);
  });

  it("branchId=all is owner-only", async () => {
    who.role = "staff";
    who.permissions = ["view_collections"];
    const res = await listGET(req("/api/collections?branchId=all"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "ALL_BRANCHES_OWNER_ONLY" });
  });
});

describe("list visibility (05 §4.3)", () => {
  it("a cashier with record_sales only gets their OWN rows (never 403)", async () => {
    const { listCollections } = await import("@/lib/repo/collections");
    who.role = "staff";
    who.permissions = ["record_sales"];
    const res = await listGET(req("/api/collections?status=pending"));
    expect(res.status).toBe(200);
    expect(vi.mocked(listCollections).mock.calls.at(-1)?.[1]).toMatchObject({ recordedByUserId: OWNER });
  });

  it("view_collections sees the branch (no recorder filter); neither key → 403", async () => {
    const { listCollections } = await import("@/lib/repo/collections");
    who.role = "staff";
    who.permissions = ["view_collections"];
    await listGET(req("/api/collections"));
    expect(vi.mocked(listCollections).mock.calls.at(-1)?.[1]).toMatchObject({ recordedByUserId: undefined });
    who.permissions = ["view_inventory"];
    const res = await listGET(req("/api/collections"));
    expect(res.status).toBe(403);
  });
});

describe("accounts visibility and masks (03 §E.5, 05 ARCH CR 9)", () => {
  it("a cashier's GET accounts carries the wallet number and IPA link but never the IBAN or balance", async () => {
    who.role = "staff";
    who.permissions = ["record_sales"];
    dbRows.accounts = [
      accountRow(),
      accountRow({ id: "88888888-8888-4888-8888-888888888888", rail: "wallet", provider: "vodafone_cash", accountLast4: null, iban: null, ipaHandle: null, ipaLink: null, walletMsisdn: "+201012345678", label: "VF" }),
    ];
    const res = await accountsGET(req("/api/collections/accounts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; branchId: string };
    expect(body.branchId).toBe(BRANCH);
    const [bank, wallet] = body.data;
    expect(bank!.iban).toBeNull();
    expect(bank!.ibanLast4).toBe("0002");
    expect(bank!.balanceBaseline).toBeNull();
    expect(bank!.ipaLink).toBe("https://ipn.eg/S/amr.shop/instapay/AbC123");
    expect(wallet!.walletMsisdn).toBe("+201012345678");
  });

  it("the owner gets the full IBAN and balance", async () => {
    dbRows.accounts = [accountRow()];
    const res = await accountsGET(req("/api/collections/accounts"));
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]!.iban).toBe("EG380019000500000000263180002");
    expect(body.data[0]!.balanceBaseline).toBe(1200);
  });

  it("every mask equals the domain accountMask() of the row and is printable ASCII", () => {
    const rows = [
      accountRow(),
      accountRow({ accountLast4: null }),
      accountRow({ accountLast4: null, iban: null, ipaHandle: null, ipaLink: null, isPrepaidCard: true }),
      accountRow({ rail: "wallet", provider: "orange_cash", accountLast4: null, ipaHandle: null, walletMsisdn: "+201212345678" }),
    ];
    for (const r of rows) {
      const a = toAccountDTO(r, false);
      expect(a.mask).toBe(accountMask(r));
      expect(a.mask).toMatch(/^[\x20-\x7E]+$/);
      const c = toCollectionDTO({
        id: CID, status: "pending", source_type: "sale", method: "wallet", amount: "10.00", part_no: 1,
        invoice_id: "INV", anchor_sale_id: null, branch_id: BRANCH, collection_account_id: r.id,
        account_label: r.label, account_provider: r.provider, account_rail: r.rail,
        account_last4: r.accountLast4, wallet_msisdn: r.walletMsisdn, ipa_handle: r.ipaHandle,
        is_prepaid_card: r.isPrepaidCard, payer_phone_last4: null, payer_reference: null,
        rung_at: "2026-09-30 10:00:00+00", rung_at_key: "2026-09-30T10:00:00+00:00",
        recorded_by_user_id: null, recorded_by_name: null, decided_by_user_id: null, decided_by_name: null,
        decided_at: null, reject_reason: null, reject_outcome: null, flags: [], matched_credit_id: null,
        customer_phone: null, is_stale: false, parts_count: 1,
      } as never);
      expect(c.account!.mask).toBe(a.mask);
      expect(c.account!.mask).not.toMatch(/[•…]/);
    }
  });
});

describe("cart route (05 §4.6)", () => {
  it("a wallet cart naming an unknown collectionAccountId still answers 201", async () => {
    const res = await cartPOST(
      req("/api/sales/cart", {
        method: "POST",
        key: "k-cart-000001",
        body: {
          lines: [{ productId: PRODUCT, quantity: 1, pricePerUnit: 100 }],
          options: { paymentMethod: "wallet", collectionAccountId: "99999999-9999-4999-8999-999999999999", payerPhoneLast4: "4321" },
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ collectionStatus: "pending", collectionIds: [CID] });
    expect(vi.mocked(recordCartSale).mock.calls.at(-1)?.[2]).toMatchObject({
      paymentMethod: "wallet",
      collectionAccountId: "99999999-9999-4999-8999-999999999999",
      payerPhoneLast4: "4321",
    });
  });

  it("malformed collection input is a client bug → 400 (5 parts, bad last-4)", async () => {
    const parts = Array.from({ length: 5 }, () => ({ accountId: ACC, amount: 10 }));
    const a = await cartPOST(
      req("/api/sales/cart", {
        method: "POST",
        key: "k-cart-000002",
        body: { lines: [{ productId: PRODUCT, quantity: 1, pricePerUnit: 100 }], options: { paymentMethod: "wallet", collectionParts: parts } },
      }),
    );
    expect(a.status).toBe(400);
    const b = await cartPOST(
      req("/api/sales/cart", {
        method: "POST",
        key: "k-cart-000003",
        body: { lines: [{ productId: PRODUCT, quantity: 1, pricePerUnit: 100 }], options: { paymentMethod: "wallet", payerPhoneLast4: "12a4" } },
      }),
    );
    expect(b.status).toBe(400);
  });
});
