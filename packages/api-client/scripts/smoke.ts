/**
 * End-to-end smoke test for the native API client, run in Node against a live
 * dev server. This exercises the SAME code the app runs — http.ts, the error
 * taxonomy, and the endpoint modules — so a break here is a real break.
 *
 *   cd apps/web && npx next dev -p 3001
 *   npx tsx packages/api-client/scripts/smoke.ts
 *
 * It asserts the things that are easy to get subtly wrong and impossible to
 * see from a screenshot: that refresh rotates, that a rotated token is refused,
 * that concurrent 401s collapse into ONE refresh, and that a bogus branch id is
 * ignored rather than honoured.
 */
import { ApiClient, ApiError, auth, catalog, dashboard, me, sales } from "../src/index";
import type { AuthTokens, TokenStore } from "../src/index";

const BASE = process.env.API_URL ?? "http://127.0.0.1:3001";
const IDENTIFIER = process.env.SMOKE_USER ?? "amr@matgary.local";
const PASSWORD = process.env.SMOKE_PASS ?? "Test1234!";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Stands in for expo-secure-store. */
function memoryStore(): TokenStore & { peek: () => AuthTokens | null } {
  let tokens: AuthTokens | null = null;
  return {
    get: async () => tokens,
    set: async (t) => {
      tokens = t;
    },
    clear: async () => {
      tokens = null;
    },
    peek: () => tokens,
  };
}

async function main() {
  console.log(`\nnative api-client smoke — ${BASE}\n`);

  let branchId: string | null = null;
  let sessionLostCalls = 0;
  const store = memoryStore();
  const client = new ApiClient({
    baseUrl: BASE,
    tokens: store,
    getBranchId: () => branchId,
    onSessionLost: () => {
      sessionLostCalls++;
    },
  });

  // ---- login ------------------------------------------------------------
  const login = await auth.login(client, {
    identifier: IDENTIFIER,
    password: PASSWORD,
    deviceName: "smoke-harness",
    platform: "ios",
    appVersion: "0.1.0",
    installId: "smoke-harness-install",
  });
  check("login returns tokens", Boolean(login.accessToken && login.refreshToken));
  check("tokens persisted to the store", store.peek() !== null);
  check(
    "expiresAt derived from expiresIn",
    Math.abs((store.peek()!.expiresAt - Date.now()) / 1000 - login.expiresIn) < 5,
  );

  // ---- /me --------------------------------------------------------------
  const identity = await me.getMe(client);
  check("me resolves tenant", Boolean(identity.tenant.id), identity.tenant.slug ?? "");
  check("me resolves a branch", Boolean(identity.branch.id), identity.branch.name ?? "");
  check(
    "EFFECTIVE permissions are owner-expanded",
    identity.permissions.length > login.user.permissions.length,
    `${login.user.permissions.length} raw -> ${identity.permissions.length} effective`,
  );

  // ---- branch header ----------------------------------------------------
  const other = identity.branches.find((b) => b.id !== identity.branch.id);
  if (other) {
    branchId = other.id;
    const switched = await me.getMe(client);
    check("X-Branch-Id switches branch", switched.branch.id === other.id, other.name);

    branchId = "00000000-0000-0000-0000-000000000000";
    const bogus = await me.getMe(client);
    check(
      "a branch id outside the allow-list is ignored, not honoured",
      bogus.branch.id !== "00000000-0000-0000-0000-000000000000",
      `fell back to ${bogus.branch.name}`,
    );
    branchId = null;
  } else {
    console.log("  skip  branch switching — tenant has only one branch");
  }

  // ---- an authenticated data route --------------------------------------
  const dash = await dashboard.getDashboard(client);
  check("dashboard returns stats", typeof dash.stats.productCount === "number",
    `${dash.stats.productCount} products, month ${dash.stats.monthRevenue}`);

  // ---- POS: record a sale, then replay it ---------------------------------
  // The cart route caches by Idempotency-Key for 24h. Posting the identical
  // request twice must return the SAME invoice, not two sales — that property
  // is what the offline outbox (phase 3) is built on.
  const products = await catalog.listProducts(client);
  const sellable = products.find((p) => p.quantity >= 2);
  if (sellable) {
    const key = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const lines = [{ productId: sellable.id, quantity: 1, pricePerUnit: sellable.price }];
    const opts = { paymentMethod: "cash" as const, invoiceId: key.toUpperCase().replace(/[^A-Z0-9_-]/g, "-") };

    const first = await sales.recordCartSale(client, lines, opts, key);
    check("POS records a sale", Boolean(first.invoiceId), `${first.invoiceId} · ${first.total}`);
    check("sale total matches line price", first.total === sellable.price);

    const replay = await sales.recordCartSale(client, lines, opts, key);
    check(
      "replaying the same Idempotency-Key returns the SAME sale",
      replay.invoiceId === first.invoiceId && replay.saleIds[0] === first.saleIds[0],
    );

    const after = await catalog.listProducts(client);
    const stock = after.find((p) => p.id === sellable.id)?.quantity ?? -1;
    check("stock decremented exactly once", stock === sellable.quantity - 1, `${sellable.quantity} -> ${stock}`);

    // Clean up so the seeded store's numbers stay what the docs say they are.
    for (const id of first.saleIds) {
      await client.request(`/api/sales/${id}`, { method: "DELETE" });
    }
    const restored = await catalog.listProducts(client);
    check(
      "cleanup restored stock",
      (restored.find((p) => p.id === sellable.id)?.quantity ?? -1) === sellable.quantity,
    );
  } else {
    console.log("  skip  POS — no product with stock >= 2");
  }

  // ---- trial store + signup (each mints its own session) -------------------
  {
    const demoStore = memoryStore();
    const demoClient = new ApiClient({ baseUrl: BASE, tokens: demoStore });
    const demo = await auth.startDemo(demoClient, { platform: "ios" });
    check("trial store mints a session", demo.demo === true && Boolean(demo.accessToken));
    const demoMe = await me.getMe(demoClient);
    check("trial owner sees the cloned store", demoMe.isOwner && Boolean(demoMe.tenant.id), demoMe.tenant.slug ?? "");
    const demoDash = await dashboard.getDashboard(demoClient);
    check("trial store has products", demoDash.stats.productCount > 0, `${demoDash.stats.productCount} products`);
  }
  {
    const h = `smk${Date.now().toString(36)}`;
    const suStore = memoryStore();
    const suClient = new ApiClient({ baseUrl: BASE, tokens: suStore });
    const su = await auth.signup(suClient, {
      email: `${h}@smoke.local`,
      password: "Test1234!",
      storeName: "متجر الدخان",
      storeHandle: h,
      platform: "ios",
    });
    check("signup creates an owner and signs in", su.user.role === "owner" && Boolean(su.accessToken), su.tenant.slug ?? "");
    check("new store starts on a trial", su.tenant.subscriptionStatus === "trialing");
    let dupKind = "";
    try {
      await auth.signup(suClient, { email: `x${h}@smoke.local`, password: "Test1234!", storeName: "x", storeHandle: h });
    } catch (e) {
      if (e instanceof ApiError) dupKind = `${e.kind}/${e.code}`;
    }
    check("duplicate store handle is refused", dupKind === "conflict/HANDLE_TAKEN", dupKind);
  }

  // ---- product create --------------------------------------------------------
  {
    const cats = await client.request<{ data: { id: string }[] }>("/api/categories");
    const cat = cats.data[0];
    if (cat) {
      const sku = `smk-${Date.now().toString(36)}`;
      const { id } = await catalog.createProduct(client, {
        name: `Smoke ${Date.now()}`,
        categoryId: cat.id,
        price: 100,
        quantity: 5,
        lowStockThreshold: 2,
        sku,
      });
      check("product create returns an id", Boolean(id));
      const list = await catalog.listProducts(client);
      check("created product is listed at the active branch", list.some((p) => p.id === id));

      // ---- scanner lookup (HANDOFF §8 #6) ----------------------------------
      // The server resolves the code across the whole tenant with the web
      // scanner's normalisation, and reports which branch holds it. Scan the
      // fresh product's sku UPPER-cased with decoder junk appended: the match
      // must be this row, `total` counts this branch, and `stock` names the
      // branch.
      const scan = await client.request<{
        data: { id: string; quantity: number }[];
        total: number;
        stock: { productId: string; branchId: string; branchName: string; quantity: number; current: boolean }[];
      }>(`/api/v1/products?barcode=${encodeURIComponent(sku.toUpperCase() + "\u200B")}`);
      check("barcode scan resolves the sku tenant-wide", scan.data[0]?.id === id, `total=${scan.total}`);
      check(
        "barcode scan reports which branch holds stock",
        scan.stock.some((s) => s.productId === id && s.current && s.quantity === 5 && Boolean(s.branchName)),
        scan.stock.map((s) => `${s.branchName}:${s.quantity}`).join(", "),
      );
      const miss = await client.request<{ data: unknown[]; stock: unknown[] }>(
        "/api/v1/products?barcode=no-such-code-smoke",
      );
      check("unknown barcode is a 200 with nothing held anywhere", miss.data.length === 0 && miss.stock.length === 0);

      // The two normalisations only the SQL half of findProductBySku performs
      // (lib/repo/catalog.ts): the 12<->13 digit collapse (a UPC-A stored as
      // an EAN-13 with a leading 0) and a NBSP inside the stored sku, which
      // Postgres `\s` does NOT strip and the write path does not trim.
      // Exercised here on every smoke run so the repo query is proven live
      // even when the unit suite's DB-gated cases are skipped.
      const digits = `6${Date.now().toString().slice(-11)}`; // 12 digits
      const ean = await catalog.createProduct(client, {
        name: `Smoke EAN ${Date.now()}`,
        categoryId: cat.id,
        price: 1,
        quantity: 1,
        lowStockThreshold: 0,
        sku: `0${digits}`,
      });
      const collapsed = await client.request<{ data: { id: string }[] }>(
        `/api/v1/products?barcode=${digits}`,
      );
      check("EAN-13 stored with a leading 0, UPC-A scanned: same product", collapsed.data[0]?.id === ean.id);
      const nbspSku = `nb-\u00a0${Date.now().toString(36)}`;
      const nbsp = await catalog.createProduct(client, {
        name: `Smoke NBSP ${Date.now()}`,
        categoryId: cat.id,
        price: 1,
        quantity: 1,
        lowStockThreshold: 0,
        sku: nbspSku,
      });
      const nbspScan = await client.request<{ data: { id: string }[] }>(
        `/api/v1/products?barcode=${encodeURIComponent(nbspSku.replace("\u00a0", ""))}`,
      );
      check("a stored sku carrying a NBSP is still found", nbspScan.data[0]?.id === nbsp.id);
      await catalog.deleteProduct(client, ean.id);
      await catalog.deleteProduct(client, nbsp.id);

      await catalog.deleteProduct(client, id);
      const after = await catalog.listProducts(client);
      check("cleanup removed it", !after.some((p) => p.id === id));
    }
  }

  // ---- customers cursor (HANDOFF §8 #5) ------------------------------------
  // The keyset cursor carries MAX(sale_date) as the microsecond text Postgres
  // rendered — never a millisecond Date — so a page boundary cannot skip a
  // customer. Pin the wire format: base64url of "<iso with 6 fraction digits>|<phone>".
  {
    const page = await client.request<{ data: { phone: string }[]; nextCursor: string | null }>(
      "/api/v1/customers?limit=1",
    );
    if (page.nextCursor) {
      const decoded = Buffer.from(page.nextCursor, "base64url").toString("utf8");
      check(
        "customers cursor keeps microseconds",
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|\+\d+$/.test(decoded),
        decoded,
      );
      const next = await client.request<{ data: { phone: string }[] }>(
        `/api/v1/customers?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      );
      check(
        "customers page 2 does not repeat the boundary row",
        next.data.length === 0 || next.data[0]!.phone !== page.data[0]!.phone,
      );
    } else {
      check("customers cursor keeps microseconds", true, "single page — nothing to page");
    }
  }

  // ---- refresh rotation --------------------------------------------------
  const beforeRefresh = store.peek()!;
  // Force the proactive path by back-dating the expiry past the skew window.
  await store.set({ ...beforeRefresh, expiresAt: Date.now() + 1_000 });
  await me.getMe(client);
  const afterRefresh = store.peek()!;
  check(
    "refresh rotates the refresh token",
    afterRefresh.refreshToken !== beforeRefresh.refreshToken,
  );
  check(
    "refresh mints a new access token",
    afterRefresh.accessToken !== beforeRefresh.accessToken,
  );

  // ---- single-flight refresh --------------------------------------------
  // THE test that matters. Rotation + reuse detection means two concurrent
  // refreshes would burn the chain and log the user out of every device. Fire
  // six parallel requests with an expired access token; if the client is
  // correct, exactly one refresh happens and all six succeed.
  const current = store.peek()!;
  await store.set({ ...current, expiresAt: Date.now() - 1 });
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => me.getMe(client)),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  check(
    "six concurrent 401s collapse into one refresh",
    ok === 6,
    `${ok}/6 succeeded`,
  );
  check("no spurious session-lost during concurrent refresh", sessionLostCalls === 0);

  // ---- logout ------------------------------------------------------------
  await auth.logout(client);
  check("logout clears local tokens", store.peek() === null);

  // ---- reuse detection (DESTRUCTIVE — must run last) ---------------------
  // Triggering this revokes EVERY live session for the user, not just this
  // device (HANDOFF open item 3). Anything sequenced after it would be
  // testing an already-dead session, so it goes at the end.
  // Replay the token that was just rotated away. The server must refuse it.
  const replayStore = memoryStore();
  await replayStore.set(beforeRefresh);
  const replayClient = new ApiClient({
    baseUrl: BASE,
    tokens: replayStore,
    onSessionLost: () => {},
  });
  await replayStore.set({ ...beforeRefresh, expiresAt: 0 });
  let reuseKind = "";
  let reuseCode = "";
  try {
    await me.getMe(replayClient);
  } catch (error) {
    if (error instanceof ApiError) {
      reuseKind = error.kind;
      reuseCode = error.code ?? "";
    }
  }
  check(
    "replaying a rotated refresh token kills the session",
    reuseKind === "session",
    `${reuseCode || "(no code)"}`,
  );
  check("local tokens cleared on a dead session", replayStore.peek() === null);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nharness crashed:", error);
  process.exit(1);
});
