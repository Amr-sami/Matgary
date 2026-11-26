import { expect, test, type APIRequestContext } from "@playwright/test";

// Contract tests for the native (/api/v1) plane — the surface the React Native
// app talks to. Pure HTTP; no browser, no cookies.
//
// These exist because the mobile client is a SECOND consumer of an API that has
// only ever had one. Every behaviour a phone depends on is asserted here, so a
// change made for the web cannot silently break it:
//
//   • bearer tokens work on the pre-existing (unmodified) routes
//   • an invalid bearer NEVER falls through to a cookie session
//   • X-Branch-Id switches branch, and a branch you do not own is ignored
//   • refresh rotates, and REUSE of a rotated token is detected and punished
//   • an owner's effective permissions are not the raw empty array
//   • a barcode miss is 200-with-empty, not 404
//
// The suite provisions its own session, so it does not depend on the shared
// storageState the browser specs use.
test.describe.configure({ mode: "serial" });
test.use({ storageState: { cookies: [], origins: [] } });

const OWNER = { identifier: "amr@matgary.local", password: "Test1234!" };

// Every test here signs in, and the native login route enforces the SAME
// buckets as the web one — login.email is 5 per 15 minutes. That limit working
// is correct product behaviour (this suite would otherwise be a way to probe
// whether native login skipped rate limiting), but it makes the suite
// self-throttling.
//
// So the run starts by clearing only the rate-limit ZSETs for this identifier,
// through the same Redis the app uses. Scoped to `rl:` keys — no session,
// cache or queue data is touched.
/** Clear ONLY the login rate-limit ZSETs, via the same Redis the app uses. */
async function resetLoginRateLimit(): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run("docker", [
      "exec", "matgary-redis", "redis-cli", "--scan", "--pattern", "*:rl:login.*",
    ]);
    const keys = stdout.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
    if (keys.length) {
      await run("docker", ["exec", "matgary-redis", "redis-cli", "DEL", ...keys]);
    }
  } catch {
    // No docker, or a hosted Redis: fall through. The suite may then trip the
    // limiter, which surfaces as a legible 429 rather than a mystery.
  }
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; role: string | null; permissions: string[] };
  tenant: { id: string; slug: string | null; subscriptionAccessActive: boolean };
  deviceId: string | null;
}

async function login(
  request: APIRequestContext,
  installId: string,
): Promise<LoginResult> {
  // Per-login, not once per file: the bucket is 5 per 15 minutes and this
  // suite signs in more often than that, so a single reset only carries the
  // first few tests.
  await resetLoginRateLimit();
  const res = await request.post("/api/v1/auth/login", {
    data: { ...OWNER, platform: "ios", deviceName: "pw-test", installId },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as LoginResult;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

test("login mints a token without a cookie or a CSRF pre-flight", async ({
  request,
}) => {
  const r = await login(request, "pw-basic");
  expect(r.accessToken).toBeTruthy();
  expect(r.refreshToken).toBeTruthy();
  expect(r.expiresIn).toBeGreaterThan(0);
  expect(r.user.email).toBe(OWNER.identifier);
  // The token must not be handed out as a cookie — that is the whole point.
  expect(r.accessToken.split(".")).toHaveLength(3);
});

test("bad credentials are rejected with a generic code", async ({ request }) => {
  const res = await request.post("/api/v1/auth/login", {
    data: { identifier: OWNER.identifier, password: "wrong-password" },
  });
  expect(res.status()).toBe(401);
  const body = await res.json();
  // Must not distinguish "no such user" from "wrong password".
  expect(body.error).toBe("INVALID_CREDENTIALS");
});

test("a bearer token works on routes that were never modified", async ({
  request,
}) => {
  const { accessToken } = await login(request, "pw-existing");
  for (const path of [
    "/api/products?limit=2",
    "/api/branches",
    "/api/pos/bootstrap",
    "/api/suppliers",
  ]) {
    const res = await request.get(path, { headers: bearer(accessToken) });
    expect(res.status(), `${path} should accept a bearer token`).toBe(200);
  }
});

test("no token, garbage token and a forged signature are all 401", async ({
  request,
}) => {
  expect((await request.get("/api/products")).status()).toBe(401);

  expect(
    (await request.get("/api/products", { headers: bearer("not.a.token") })).status(),
  ).toBe(401);

  // Correctly-shaped JWT, wrong signing key. Must not be accepted, and must
  // not quietly downgrade to whatever session the request might otherwise have.
  const seg = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const forged = `${seg({ alg: "HS256", typ: "JWT" })}.${seg({
    sub: "x",
    tenantId: "y",
    iss: "matgary",
    aud: "matgary-native",
    exp: Math.floor(Date.now() / 1000) + 999,
  })}.bm90LWEtcmVhbC1zaWduYXR1cmU`;
  expect(
    (await request.get("/api/products", { headers: bearer(forged) })).status(),
  ).toBe(401);
});

test("X-Branch-Id switches branch; a branch you do not own is ignored", async ({
  request,
}) => {
  const { accessToken } = await login(request, "pw-branch");
  const h = bearer(accessToken);

  const me = await request.get("/api/v1/me", { headers: h });
  expect(me.status()).toBe(200);
  const meBody = await me.json();
  const branches: Array<{ id: string; name: string }> = meBody.branches ?? [];
  test.skip(branches.length < 2, "needs a tenant with two branches");

  const other = branches.find((b) => b.id !== meBody.branch?.id)!;
  const switched = await request.get("/api/pos/bootstrap", {
    headers: { ...h, "X-Branch-Id": other.id },
  });
  expect(switched.status()).toBe(200);
  expect((await switched.json()).branch?.id).toBe(other.id);

  // A syntactically valid id that is not in the caller's allow-list must be
  // ignored, exactly as a tampered mg.branch cookie always was — NOT honoured,
  // and not a 500.
  const foreign = await request.get("/api/pos/bootstrap", {
    headers: { ...h, "X-Branch-Id": "00000000-0000-0000-0000-000000000000" },
  });
  expect(foreign.status()).toBe(200);
  expect((await foreign.json()).branch?.id).not.toBe(
    "00000000-0000-0000-0000-000000000000",
  );
});

test("/api/v1/me returns EFFECTIVE permissions for an owner", async ({
  request,
}) => {
  const { accessToken } = await login(request, "pw-me");
  const res = await request.get("/api/v1/me", { headers: bearer(accessToken) });
  expect(res.status()).toBe(200);
  const body = await res.json();

  expect(body.user?.id).toBeTruthy();
  expect(body.tenant?.id).toBeTruthy();
  expect(body.branch?.id).toBeTruthy();

  // An owner's raw permissions column is EMPTY — `can()` grants everything via
  // the role instead. A client that renders navigation from this response would
  // show an owner nothing at all, so the endpoint must expose the effective
  // set (or an explicit owner flag the client can branch on).
  const isOwner = body.user?.role === "owner" || body.isOwner === true;
  if (isOwner) {
    const permsUsable =
      (Array.isArray(body.permissions) && body.permissions.length > 0) ||
      body.isOwner === true;
    expect(
      permsUsable,
      "owner must get a usable permission signal, not an empty array",
    ).toBe(true);
  }
});

test("refresh rotates the pair, and reusing a rotated token is detected", async ({
  request,
}) => {
  const first = await login(request, "pw-rotate");

  const r1 = await request.post("/api/v1/auth/refresh", {
    data: { refreshToken: first.refreshToken },
  });
  expect(r1.status(), await r1.text()).toBe(200);
  const second = (await r1.json()) as LoginResult;
  expect(second.refreshToken).toBeTruthy();
  // Rotation means a NEW refresh token, not the same one handed back.
  expect(second.refreshToken).not.toBe(first.refreshToken);

  // The new access token must actually work.
  expect(
    (await request.get("/api/v1/me", { headers: bearer(second.accessToken) })).status(),
  ).toBe(200);

  // Presenting the ALREADY-ROTATED token is the leak signal. It must fail, and
  // it must take the whole chain down with it — a refresh token lives on a
  // device we do not control, so a silent 90-day window is unacceptable.
  const replay = await request.post("/api/v1/auth/refresh", {
    data: { refreshToken: first.refreshToken },
  });
  expect(replay.status()).toBe(401);

  const afterReplay = await request.post("/api/v1/auth/refresh", {
    data: { refreshToken: second.refreshToken },
  });
  expect(
    afterReplay.status(),
    "reuse should revoke the chain, so the newest token dies too",
  ).toBe(401);
});

test("logout is idempotent and never leaks whether a token existed", async ({
  request,
}) => {
  const r = await login(request, "pw-logout");
  expect((await request.post("/api/v1/auth/logout", { data: { refreshToken: r.refreshToken } })).status()).toBe(200);
  // Second call, same token: still 200. A retry on a flaky network must not
  // strand the client, and a 404 would reveal which tokens exist.
  expect((await request.post("/api/v1/auth/logout", { data: { refreshToken: r.refreshToken } })).status()).toBe(200);
  // A WELL-FORMED but unknown token — this is the case that must not leak.
  // (A short string is rejected as INVALID_BODY on shape alone, before any
  // lookup, which leaks nothing and is correct.)
  const unknownButValidShape = Buffer.from(
    "unknown-token-that-was-never-issued-0123456789",
  ).toString("base64url");
  expect(
    (await request.post("/api/v1/auth/logout", { data: { refreshToken: unknownButValidShape } })).status(),
    "an unknown token must not be distinguishable from a real one",
  ).toBe(200);
});

test("dashboard returns the home-screen numbers over HTTP", async ({
  request,
}) => {
  const { accessToken } = await login(request, "pw-dash");
  const res = await request.get("/api/v1/dashboard", {
    headers: bearer(accessToken),
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(typeof body).toBe("object");
  expect(Object.keys(body).length).toBeGreaterThan(0);
});

test("customers paginate by cursor without repeating rows", async ({
  request,
}) => {
  const { accessToken } = await login(request, "pw-cust");
  const h = bearer(accessToken);

  const p1 = await request.get("/api/v1/customers?limit=5", { headers: h });
  expect(p1.status(), await p1.text()).toBe(200);
  const b1 = await p1.json();
  expect(Array.isArray(b1.data)).toBe(true);

  if (b1.nextCursor) {
    const p2 = await request.get(
      `/api/v1/customers?limit=5&cursor=${encodeURIComponent(b1.nextCursor)}`,
      { headers: h },
    );
    expect(p2.status()).toBe(200);
    const b2 = await p2.json();
    const firstPhones = new Set(b1.data.map((c: { phone: string }) => c.phone));
    for (const row of b2.data as Array<{ phone: string }>) {
      expect(
        firstPhones.has(row.phone),
        "page 2 must not repeat a row from page 1",
      ).toBe(false);
    }
  }
});

test("product search: text, and a barcode miss is 200-with-empty not 404", async ({
  request,
}) => {
  const { accessToken } = await login(request, "pw-prod");
  const h = bearer(accessToken);

  const q = await request.get("/api/v1/products?q=Dior", { headers: h });
  expect(q.status(), await q.text()).toBe(200);
  expect(Array.isArray((await q.json()).data)).toBe(true);

  // "No product with this barcode" is a normal POS outcome — the cashier is
  // offered the add-product flow. Returning 404 would make a routine scan look
  // like a transport failure.
  const miss = await request.get("/api/v1/products?barcode=0000000000000", {
    headers: h,
  });
  expect(miss.status()).toBe(200);
  expect((await miss.json()).data).toHaveLength(0);
});

test("devices lists the caller's sessions and never exposes a token hash", async ({
  request,
}) => {
  const r = await login(request, "pw-devices");
  const res = await request.get("/api/v1/auth/devices", {
    headers: bearer(r.accessToken),
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  const rows = (body.data ?? body.devices ?? body) as Array<Record<string, unknown>>;
  expect(Array.isArray(rows)).toBe(true);
  const serialised = JSON.stringify(rows);
  expect(serialised).not.toContain("refresh_token_hash");
  expect(serialised).not.toContain("refreshTokenHash");
});
