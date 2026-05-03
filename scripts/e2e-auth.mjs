// End-to-end test of the auth flows over HTTP, exactly like a browser would.
// Walks Auth.js's csrf -> credentials callback path to set the JWT cookie,
// then verifies tenant-scoped API endpoints work.

const BASE = process.env.BASE_URL || "http://localhost:3000";

const cookieJar = new Map();

function parseSetCookie(headers) {
  const all = headers.getSetCookie?.() || [];
  for (const c of all) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      cookieJar.set(name, value);
    }
  }
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function http(method, path, body, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(),
      ...(init.headers || {}),
    },
    body,
  });
  parseSetCookie(res.headers);
  return res;
}

async function form(path, fields) {
  const body = new URLSearchParams(fields).toString();
  return http("POST", path, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function getJson(path) {
  const res = await http("GET", path);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, location: res.headers.get("location") };
}

async function getCsrf() {
  const res = await fetch(`${BASE}/api/auth/csrf`, {
    headers: { Cookie: cookieHeader() },
  });
  parseSetCookie(res.headers);
  const json = await res.json();
  return json.csrfToken;
}

async function signInWithCredentials(email, password) {
  const csrfToken = await getCsrf();
  const res = await form("/api/auth/callback/credentials?", {
    csrfToken,
    email,
    password,
    callbackUrl: `${BASE}/`,
    redirect: "false",
    json: "true",
  });
  return { status: res.status, location: res.headers.get("location") };
}

function ok(label, condition, extra = "") {
  const mark = condition ? "✅" : "❌";
  console.log(`${mark} ${label}${extra ? "  " + extra : ""}`);
  if (!condition) process.exitCode = 1;
}

async function main() {
  console.log("\n— sanity: unauth pages —");
  const r1 = await getJson("/api/sales");
  ok("/api/sales without auth → 401", r1.status === 401, `got ${r1.status}`);

  const r2 = await getJson("/login");
  ok("/login → 200", r2.status === 200, `got ${r2.status}`);

  const r3 = await getJson("/");
  ok("/ unauth → 307 → /login", r3.status === 307 && (r3.location || "").endsWith("/login"), `status=${r3.status} loc=${r3.location}`);

  console.log("\n— login as the seeded user —");
  const login = await signInWithCredentials("test@matgary.local", "Test1234!");
  ok("credentials callback returned (no error url)", !(login.location || "").includes("error"), `loc=${login.location}`);

  const sessionRes = await getJson("/api/auth/session");
  const session = sessionRes.json;
  ok("session has user.id", !!session?.user?.id, JSON.stringify(session?.user || {}));
  ok("session has user.tenantId", !!session?.user?.tenantId);
  ok("session.user.onboardingComplete = true", session?.user?.onboardingComplete === true);

  console.log("\n— authed API requests scoped to that tenant —");
  const cats = await getJson("/api/categories");
  ok("/api/categories → 200", cats.status === 200, `status=${cats.status}`);
  const catCount = cats.json?.data?.length ?? 0;
  ok("3 categories present (cornerstore preset)", catCount === 3, `got ${catCount}`);

  const prods = await getJson("/api/products");
  ok("/api/products → 200", prods.status === 200, `status=${prods.status}`);
  const prodCount = prods.json?.data?.length ?? 0;
  ok("2 products present (seed)", prodCount === 2, `got ${prodCount}`);

  const settings = await getJson("/api/settings");
  ok("/api/settings → 200", settings.status === 200);
  ok("settings.shopName populated", !!settings.json?.data?.shopName);

  const onboarding = await getJson("/onboarding");
  // After signin, the seeded user IS onboarded — this page should still
  // render (we removed the gate); we just want it not to redirect/crash.
  ok("/onboarding doesn't crash after sign-in", onboarding.status === 200, `status=${onboarding.status}`);

  console.log("\n— sign out —");
  const csrfOut = await getCsrf();
  const out = await form("/api/auth/signout", {
    csrfToken: csrfOut,
    callbackUrl: `${BASE}/login`,
    json: "true",
  });
  ok("signout returned", out.status >= 200 && out.status < 400, `status=${out.status}`);
  cookieJar.delete("authjs.session-token");
  cookieJar.delete("__Secure-authjs.session-token");

  console.log("\n— back to unauth state —");
  const r4 = await getJson("/api/sales");
  ok("/api/sales after signout → 401", r4.status === 401, `got ${r4.status}`);

  console.log("\n— wrong-password login is rejected —");
  const wrong = await signInWithCredentials("test@matgary.local", "wrongpass");
  ok(
    "wrong password → callback url contains 'error' OR no session",
    (wrong.location || "").includes("error") || !(await getJson("/api/auth/session")).json?.user?.id,
    `loc=${wrong.location}`,
  );

  console.log("\n— done —");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
