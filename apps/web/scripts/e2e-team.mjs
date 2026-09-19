// E2E test for the team / RBAC feature.
// 1) login as the seeded owner
// 2) create an employee with a limited permission set via /api/team
// 3) login as that employee (synthetic email username@tenant-slug)
// 4) hit endpoints they DO have permission for → 200
// 5) hit endpoints they DON'T have permission for → 403
// 6) verify mustChangePassword was true (newly created sub-account)
// 7) change password via /api/account/password → mustChangePassword flips false
// 8) verify owner-protected /api/team is forbidden for the employee

const BASE = process.env.BASE_URL || "http://localhost:3000";

let cookieJar = new Map();

function reset() {
  cookieJar = new Map();
}

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

async function getJson(path) {
  const res = await http("GET", path);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, location: res.headers.get("location") };
}

async function getCsrf() {
  const res = await fetch(`${BASE}/api/auth/csrf`, { headers: { Cookie: cookieHeader() } });
  parseSetCookie(res.headers);
  return (await res.json()).csrfToken;
}

async function signInWithCredentials(email, password) {
  const csrfToken = await getCsrf();
  const body = new URLSearchParams({
    csrfToken,
    email,
    password,
    callbackUrl: `${BASE}/`,
    redirect: "false",
    json: "true",
  }).toString();
  const res = await fetch(`${BASE}/api/auth/callback/credentials?`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(),
    },
    body,
  });
  parseSetCookie(res.headers);
  return { status: res.status, location: res.headers.get("location") };
}

function ok(label, cond, extra = "") {
  const m = cond ? "✅" : "❌";
  console.log(`${m} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) process.exitCode = 1;
}

async function postJson(path, body) {
  const res = await http("POST", path, JSON.stringify(body));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function reseed() {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("npm", ["run", "db:seed"], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error("seed failed", r.stdout, r.stderr);
    throw new Error("seed failed");
  }
}

async function main() {
  await reseed();
  // 1) login owner
  console.log("\n— login as owner —");
  reset();
  const ownerLogin = await signInWithCredentials("test@matgary.local", "Test1234!");
  ok("owner credentials accepted", !(ownerLogin.location || "").includes("error"));
  const ownerSession = (await getJson("/api/auth/session")).json;
  ok("owner session has role=owner", ownerSession?.user?.role === "owner");
  ok("owner session has tenantSlug", !!ownerSession?.user?.tenantSlug, `slug=${ownerSession?.user?.tenantSlug}`);
  const slug = ownerSession.user.tenantSlug;

  // 2) create employee
  console.log("\n— owner creates an employee —");
  const username = "ahmed";
  const empPassword = "Cashier1!";
  const create = await postJson("/api/team", {
    username,
    displayName: "Ahmed",
    password: empPassword,
    permissions: ["view_dashboard", "view_inventory", "view_sales", "record_sales"],
  });
  ok("POST /api/team → 201", create.status === 201, `status=${create.status} body=${JSON.stringify(create.json)}`);
  const empLoginEmail = `${username}@${slug}`;
  ok(`synthetic email built (${empLoginEmail})`, true);

  const teamList = (await getJson("/api/team")).json;
  ok("owner sees 2 members in /api/team", teamList?.data?.length === 2, `count=${teamList?.data?.length}`);

  // 3) login as employee
  console.log("\n— login as employee —");
  reset();
  const empLogin = await signInWithCredentials(empLoginEmail, empPassword);
  ok("employee credentials accepted", !(empLogin.location || "").includes("error"));
  const empSession = (await getJson("/api/auth/session")).json;
  ok("employee session role=staff", empSession?.user?.role === "staff", `role=${empSession?.user?.role}`);
  ok("employee mustChangePassword=true", empSession?.user?.mustChangePassword === true);
  ok("employee permissions saved", JSON.stringify(empSession?.user?.permissions || []).includes("record_sales"));

  // 4) Until password is changed, middleware blocks every other API + page.
  console.log("\n— must-change-password gate is enforced —");
  const blockedSales = await getJson("/api/sales");
  ok("/api/sales blocked while mustChangePassword=true", blockedSales.status === 403 && blockedSales.json?.error === "PASSWORD_CHANGE_REQUIRED", `status=${blockedSales.status} err=${blockedSales.json?.error}`);

  const dash = await getJson("/");
  ok("/ redirects employee to /account/change-password", dash.status === 307 && (dash.location || "").includes("/account/change-password"), `loc=${dash.location}`);

  // 5) employee changes password
  console.log("\n— employee changes password —");
  const changed = await postJson("/api/account/password", {
    currentPassword: empPassword,
    newPassword: "Permanent1!",
  });
  ok("password change succeeds", changed.status === 200, `status=${changed.status} body=${JSON.stringify(changed.json)}`);

  // After change, the JWT cookie still says mustChangePassword=true until the
  // next session check runs the jwt callback. Hitting /api/auth/session forces it.
  const refreshed = (await getJson("/api/auth/session")).json;
  ok("after refresh mustChangePassword=false", refreshed?.user?.mustChangePassword === false);

  // 6) NOW permissions take effect on regular APIs.
  console.log("\n— allowed APIs —");
  const sales = await getJson("/api/sales");
  ok("/api/sales → 200 (employee can view sales)", sales.status === 200, `status=${sales.status}`);

  // 7) forbidden endpoint — manage_team
  console.log("\n— forbidden APIs —");
  const teamForbidden = await getJson("/api/team");
  ok("/api/team → 403 (employee lacks manage_team)", teamForbidden.status === 403, `status=${teamForbidden.status}`);

  const dash2 = await getJson("/");
  ok("/ no longer bounces to change-password", dash2.status !== 307 || !(dash2.location || "").includes("change-password"), `status=${dash2.status} loc=${dash2.location}`);

  // 7) employee cannot use new credentials BEFORE cleanup; we’re done.
  console.log("\n— done —");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
