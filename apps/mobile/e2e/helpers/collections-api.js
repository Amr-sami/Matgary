// collections-api.js — host-side HTTP helper for the digital-collections
// Maestro flows (doc 15 spec 15 §4.4). NOT a flow: run.sh only runs
// e2e/*.yaml, and this file is only ever called as
//
//   - runScript:
//       file: helpers/collections-api.js
//       env: { MODE: setup }            # setup | sale | expect | decide | mark
//
// Maestro runs it on the HOST (GraalJS), with an `http` object
// (get/post/request → { ok, status, body }), `json()`, the flow's `output`
// (shared by every runScript of one flow run) and every env value as a
// global. The host reaches the backend at 127.0.0.1 on both platforms; only
// the app under test uses 10.0.2.2 on Android.
//
// Contract (spec 15 §4.4):
//   setup   login the owner, turn the branch switch on, refuse a backend whose
//           COLLECTIONS_ENABLED flag is off, ensure the two fixture accounts
//           (E2E CIB, E2E VF — both POS defaults), confirm leftover pending
//           rows on them older than 30 min and archive "E2E QNB|EM <stamp>"
//           accounts a failed collections-accounts run left active (debris;
//           nothing is ever deleted). → output.cibId, vfId, vfDigits, payer,
//           stamp
//           M2 (NEED=ingest): also refuse a backend whose
//           COLLECTIONS_INGEST_ENABLED flag is off, soft-revoke live
//           "E2E wizard <stamp>" devices older than 30 min (debris)
//           → + output.ref12, vf1Text
//   sale    METHOD (instapay|wallet|deferred) ACCOUNT (cib|vf|none)
//           PHONE (new|empty) KEY (output prefix) PRICE (optional; the
//           line's pricePerUnit, quantity 1 — collections-credits passes
//           2700, VF-1's amount)
//           → output.<KEY>Inv, <KEY>Coll, <KEY>Phone, <KEY>PhoneEnc, <KEY>Total
//   expect  CHECK + its args; throws on mismatch (the flow fails with the
//           message). Checks: pendingByPayer, status, ledgerUnpaid,
//           ledgerPaid, settlementPending, rungAt, noAccount, accountByLabel,
//           archived, prefsCollections; M2: creditByRef (→ cCredit),
//           creditMatched, deviceByLabel (→ devId), deviceSeen,
//           deviceRevoked, noLiveDevice.
//   decide  ACTION (confirm|reject|reopen) ID REASON OUTCOME — the API
//           decision where the decision is not what the flow tests.
//   paste   (M2) ACCOUNT (cib|vf|uuid) [TEXT, default output.vf1Text] —
//           POST /api/collections/credits/paste, the spec 15 §4.5.6 step 4
//           fallback: Maestro 2.10.0's pasteText types through inputText,
//           which cannot type Arabic on Android, so the Android branch of
//           collections-credits pastes by API (iOS pastes through the UI).
//   mark    → output.ringAt = now (epoch ms)
//
// Dev-only: any API_ORIGIN that is not 127.0.0.1 / localhost is refused, so
// no flow can ever point this at production. The M2 additions of §4.4 landed
// with collections-credits.yaml and collections-wizard-simulate.yaml
// (README §3 order 25).
//
// Response shape note (spec 15 R1): only `status` and `body` are read, so a
// Maestro build whose response has no `ok` still works.

(function main() {
  // ---- constants (mirror login.yaml / permission-denied.yaml) ------------
  var OWNER = { identifier: "amr@matgary.local", password: "Test1234!" };
  var DEVICE = { name: "maestro-collections", platform: "ios", installId: "maestro-collections" };
  var STALE_DEBRIS_MS = 30 * 60 * 1000;
  // Fixture accounts (03 §B.2.1 regexes; the IBAN passes mod-97, 09 §7).
  // accountLast4 is 4829, not the spec's 4821: the dev tenant already holds a
  // hand-made "CIB business" on cib/4821, and reusing it by identity would
  // rename that account (spec 15 deviation, see the order-12 report).
  var FIXTURES = {
    cib: {
      rail: "instapay",
      provider: "cib",
      label: "E2E CIB",
      ipaHandle: "e2e-cib@instapay",
      ipaLink: "https://ipn.eg/S/e2e-cib/instapay/E2eCib01",
      accountLast4: "4829",
      iban: "EG380019000500000000263180002",
      holderName: "E2E STORE",
      isPosDefault: true,
      branchId: null,
    },
    vf: {
      rail: "wallet",
      provider: "vodafone_cash",
      label: "E2E VF",
      walletMsisdn: "+201098765432",
      isPosDefault: true,
      branchId: null,
    },
  };
  var VF_DIGITS = "010 9876 5432"; // formatWalletNumber(+201098765432)
  // The five collection.* event types of 13 §4.2 (owner sees all five).
  // M2: VF-1's FILLED text (06 §4.14), verbatim.
  // = SAMPLES["VF-1"].text (packages/domain/src/collections/__fixtures__/samples.ts)
  var VF1_TEXT =
    "تم استلام مبلغ 2700.00 جنيه من رقم 01127777705 المسجل بإسم محمد احمد علي على رقم محفظتك  01007777765.\n" +
    "رصيدك الحالي: 2724.51 جنيه\n" +
    "تاريخ العملية: 17:36 26-07-27\n" +
    "رقم العملية: 022177777777\n" +
    "تابع كل مصروفاتك من تاريخ المعاملات على أبلكيشن أنا فودافون http://vf.eg/vfcash";
  var VF1_REF = "022177777777";
  var VF1_WHEN = "17:36 26-07-27"; // HH:MM YY-MM-DD, Africa/Cairo
  var WIZARD_LABEL = /^E2E wizard /;
  var COLLECTION_EVENTS = [
    "collection.pending",
    "collection.stale",
    "collection.unmatched_credit",
    "collection.source_silent",
    "collection.limit_warning",
  ];

  // ---- env -----------------------------------------------------------------
  function env(name, fallback) {
    // Maestro exposes env values as globals; an absent one is a ReferenceError.
    try {
      // eslint-disable-next-line no-eval
      var v = eval("typeof " + name + " === 'undefined' ? undefined : " + name);
      if (v === undefined || v === null || String(v) === "") return fallback;
      return String(v);
    } catch (e) {
      return fallback;
    }
  }

  var ORIGIN = env("API_ORIGIN", "http://127.0.0.1:3003").replace(/\/+$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(ORIGIN)) {
    throw new Error("collections-api.js is dev-only (API_ORIGIN=" + ORIGIN + ")");
  }

  function fail(msg) {
    throw new Error("collections-api: " + msg);
  }

  function parse(body) {
    if (body === undefined || body === null || String(body) === "") return null;
    try {
      return typeof json === "function" ? json(String(body)) : JSON.parse(String(body));
    } catch (e) {
      return String(body);
    }
  }

  function rawCall(method, path, body, headers) {
    var url = ORIGIN + path;
    var opts = { headers: headers || {} };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var res;
    if (method === "GET") res = http.get(url, opts);
    else if (method === "POST") res = http.post(url, opts);
    else {
      opts.method = method;
      res = http.request(url, opts);
    }
    return { status: Number(res.status), data: parse(res.body) };
  }

  function login() {
    var r = rawCall("POST", "/api/v1/auth/login", {
      identifier: OWNER.identifier,
      password: OWNER.password,
      device: DEVICE,
    }, { "Content-Type": "application/json" });
    if (r.status !== 200 || !r.data || !r.data.accessToken) {
      fail("owner login failed: " + r.status + " " + JSON.stringify(r.data));
    }
    output.colApiToken = r.data.accessToken;
    return output.colApiToken;
  }

  function call(method, path, body, extraHeaders) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var tok = output.colApiToken || login();
      var h = { Authorization: "Bearer " + tok };
      if (body !== undefined) h["Content-Type"] = "application/json";
      for (var k in extraHeaders || {}) h[k] = extraHeaders[k];
      var r = rawCall(method, path, body, h);
      if (r.status === 401 && attempt === 0) {
        output.colApiToken = null; // expired mid-flow: log in again once
        continue;
      }
      return r;
    }
    return r;
  }

  function must(r, codes, what) {
    if (codes.indexOf(r.status) === -1) {
      fail(what + " → " + r.status + " " + JSON.stringify(r.data));
    }
    return r.data;
  }

  function rand(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += String(Math.floor(Math.random() * 10));
    return s;
  }

  function accountId(alias) {
    if (alias === "cib") return output.cibId || fail("setup did not run (no cibId)");
    if (alias === "vf") return output.vfId || fail("setup did not run (no vfId)");
    if (!alias || alias === "none") return null;
    return alias; // a raw uuid
  }

  function digits(p) {
    return String(p || "").replace(/\D/g, "").slice(-10);
  }

  function listAccounts(query) {
    var d = must(call("GET", "/api/collections/accounts" + (query || "")), [200], "GET accounts");
    return (d && d.data) || [];
  }

  function listCollections(query) {
    var d = must(call("GET", "/api/collections?" + query), [200], "GET collections?" + query);
    return (d && d.data) || [];
  }

  function getCollection(id) {
    return must(call("GET", "/api/collections/" + encodeURIComponent(id)), [200], "GET collection " + id);
  }

  function ledger(phone) {
    var r = call("GET", "/api/customers/by-phone/" + encodeURIComponent(phone));
    return must(r, [200], "GET customer " + phone).data;
  }

  // ---- setup ---------------------------------------------------------------
  function sameIdentity(a, f) {
    if (a.provider !== f.provider) return false;
    if (f.rail === "wallet") return digits(a.walletMsisdn) === digits(f.walletMsisdn);
    return (
      (f.accountLast4 && a.accountLast4 === f.accountLast4) ||
      (f.ipaHandle && a.ipaHandle === f.ipaHandle)
    );
  }

  function patchFor(a, f) {
    var patch = {};
    var keys = ["label", "holderName", "ipaHandle", "ipaLink", "accountLast4", "walletMsisdn", "isPosDefault", "branchId"];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!(k in f)) continue;
      var have = a[k] === undefined ? null : a[k];
      var want = f[k];
      if (k === "walletMsisdn" ? digits(have) !== digits(want) : have !== want) patch[k] = want;
    }
    if (f.iban && String(a.iban || "").replace(/\s/g, "").toUpperCase() !== f.iban) patch.iban = f.iban;
    return patch;
  }

  function ensureAccount(alias, stamp) {
    var f = FIXTURES[alias];
    var all = listAccounts("?scope=all");
    var hit = null;
    for (var i = 0; i < all.length && !hit; i++) if (all[i].label === f.label) hit = all[i];
    for (var j = 0; j < all.length && !hit; j++) if (sameIdentity(all[j], f)) hit = all[j];
    if (!hit) {
      var created = call("POST", "/api/collections/accounts", f, { "Idempotency-Key": "e2e-acct-" + alias + "-" + stamp });
      if (created.status === 201) return created.data.id;
      if (created.status !== 409) must(created, [201], "POST account " + f.label);
      // A row outside this branch's list holds the identity: find it anywhere.
      all = listAccounts("?scope=all&includeArchived=1");
      for (var m = 0; m < all.length && !hit; m++) if (!all[m].archivedAt && sameIdentity(all[m], f)) hit = all[m];
      if (!hit) must(created, [201], "POST account " + f.label + " (duplicate, owner row not found)");
    }
    var patch = patchFor(hit, f);
    if (Object.keys(patch).length > 0) {
      must(call("PATCH", "/api/collections/accounts/" + hit.id, patch), [200], "PATCH account " + f.label);
    }
    return hit.id;
  }

  function cleanDebris(accId) {
    var cutoff = Date.now() - STALE_DEBRIS_MS;
    var rows = listCollections("status=pending&accountId=" + accId + "&order=asc&limit=100");
    var used = [];
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      if (Date.parse(c.rungAt) < cutoff) {
        var r = call("POST", "/api/collections/" + c.id + "/confirm", {}, { "Idempotency-Key": "e2e-clean-" + c.id });
        must(r, [200, 409], "confirm debris " + c.id);
      } else if (c.payerPhoneLast4) {
        used.push(c.payerPhoneLast4);
      }
    }
    return used;
  }

  // collections-accounts.yaml creates "E2E QNB <stamp>" and "E2E EM <stamp>"
  // and archives them at its end. A run that failed half-way leaves them
  // active, and the next run's save would hit the provider+last-4 / wallet
  // unique index: archive them (the UI's own action; nothing is deleted).
  function archiveAccountDebris() {
    var rows = listAccounts("?scope=all");
    for (var i = 0; i < rows.length; i++) {
      if (/^E2E (QNB|EM) \d+/.test(rows[i].label)) {
        must(call("DELETE", "/api/collections/accounts/" + rows[i].id), [200], "archive debris account " + rows[i].label);
      }
    }
  }

  // ---- M2 helpers ------------------------------------------------------------
  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  // Egypt's DST (Law 24/2023): UTC+3 from the last Friday of April 00:00 to
  // the last Thursday of October 24:00 local, UTC+2 otherwise.
  function lastWeekday(year, month0, weekday) {
    var d = new Date(Date.UTC(year, month0 + 1, 0)); // last day of the month
    while (d.getUTCDay() !== weekday) d = new Date(d.getTime() - 86400000);
    return d;
  }

  function cairoOffsetMinutes(ms) {
    var y = new Date(ms).getUTCFullYear();
    var start = lastWeekday(y, 3, 5).getTime() - 2 * 3600000; // Fri 00:00 local (UTC+2)
    var end = lastWeekday(y, 9, 4).getTime() + 24 * 3600000 - 3 * 3600000; // Thu 24:00 local (UTC+3)
    return ms >= start && ms < end ? 180 : 120;
  }

  // "HH:MM YY-MM-DD" in Africa/Cairo — VF-1's own shape. Intl first (GraalJS
  // may ship without full ICU), the DST rule above as the fallback.
  function cairoStamp(ms) {
    try {
      var parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo", year: "2-digit", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(ms));
      var m = {};
      for (var i = 0; i < parts.length; i++) m[parts[i].type] = parts[i].value;
      if (m.hour && m.minute && m.year && m.month && m.day) {
        return m.hour + ":" + m.minute + " " + m.year + "-" + m.month + "-" + m.day;
      }
    } catch (e) {
      // fall through
    }
    var d = new Date(ms + cairoOffsetMinutes(ms) * 60000);
    return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + " " +
      String(d.getUTCFullYear()).slice(-2) + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  // VF-1 with this run's reference and "now" (spec 15 §4.4): without them a
  // second run's paste is a `duplicate` of the first run's matched credit, and
  // the message would fall outside a fresh sale's match window.
  function vf1For(ref12, ms) {
    var text = VF1_TEXT.split(VF1_REF).join(ref12).split(VF1_WHEN).join(cairoStamp(ms));
    if (text.indexOf(ref12) === -1 || text === VF1_TEXT) fail("vf1Text substitution failed");
    return text;
  }

  function listDevices() {
    var d = must(call("GET", "/api/collections/devices"), [200], "GET collections/devices");
    return (d && d.devices) || [];
  }

  function liveDevices() {
    return listDevices().filter(function (d) { return !d.revokedAt; });
  }

  function revokeDeviceDebris() {
    var cutoff = Date.now() - STALE_DEBRIS_MS;
    var rows = liveDevices();
    for (var i = 0; i < rows.length; i++) {
      if (WIZARD_LABEL.test(rows[i].label) && Date.parse(rows[i].createdAt) < cutoff) {
        must(call("DELETE", "/api/collections/devices/" + rows[i].id), [200, 404], "revoke debris device " + rows[i].label);
      }
    }
  }

  function setup() {
    var stamp = Date.now();
    var needIngest = env("NEED", "") === "ingest";
    login();
    var s = call("PATCH", "/api/collections/settings", { collectionsEnabled: true, collectionsRequireAccount: true });
    if (s.status === 403 && s.data && s.data.error === "COLLECTIONS_DISABLED") {
      fail("backend flag off — start :3003 with COLLECTIONS_ENABLED=on");
    }
    must(s, [200], "PATCH collections/settings");
    var me = must(call("GET", "/api/v1/me"), [200], "GET /api/v1/me");
    if (!me || !me.features || me.features.collections !== true) {
      fail("backend flag off — start :3003 with COLLECTIONS_ENABLED=on (features=" + JSON.stringify(me && me.features) + ")");
    }
    if (needIngest && me.features.collectionsIngest !== true) {
      fail("backend ingest off — start :3003 with COLLECTIONS_INGEST_ENABLED=on (features=" + JSON.stringify(me.features) + ")");
    }
    archiveAccountDebris();
    if (needIngest) revokeDeviceDebris();
    output.cibId = ensureAccount("cib", stamp);
    output.vfId = ensureAccount("vf", stamp);
    var used = cleanDebris(output.cibId).concat(cleanDebris(output.vfId));
    var payer;
    do {
      payer = String(1000 + Math.floor(Math.random() * 9000));
    } while (used.indexOf(payer) !== -1);
    output.vfDigits = VF_DIGITS;
    output.payer = payer;
    output.stamp = String(stamp);
    if (needIngest) {
      output.ref12 = rand(12);
      output.vf1Text = vf1For(output.ref12, stamp);
    }
    console.log("collections-api setup: cib=" + output.cibId + " vf=" + output.vfId + " payer=" + payer +
      (needIngest ? " ref12=" + output.ref12 : ""));
  }

  // ---- sale ----------------------------------------------------------------
  function sale() {
    var method = env("METHOD", "instapay");
    var accountAlias = env("ACCOUNT", "none");
    var phoneMode = env("PHONE", "");
    var key = env("KEY", "s");
    var price = env("PRICE", "");
    var prods = must(call("GET", "/api/v1/products?limit=50"), [200], "GET products");
    var rows = (prods && prods.data) || [];
    var best = null;
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i];
      if (p.quantity >= 1 && p.price >= 10 && (!best || p.quantity > best.quantity)) best = p;
    }
    if (!best) fail("no product with stock >= 1 (re-seed: npm run db:seed:rich)");
    var options = { paymentMethod: method, customerName: "E2E " + key };
    var acc = accountId(accountAlias);
    if (acc) options.collectionAccountId = acc;
    var phone = null;
    if (phoneMode === "new") {
      phone = "+2010" + rand(8);
      options.customerPhone = phone;
    }
    var unit = price ? Number(price) : best.price;
    var r = call(
      "POST",
      "/api/sales/cart",
      { lines: [{ productId: best.id, quantity: 1, pricePerUnit: unit }], options: options },
      { "Idempotency-Key": "e2e-" + Date.now() + "-" + rand(6) },
    );
    var res = must(r, [201], "POST sales/cart (" + method + ")");
    var digital = method === "instapay" || method === "wallet";
    if (digital && res.collectionStatus !== "pending") {
      fail("digital sale not pending: " + JSON.stringify(res));
    }
    output[key + "Inv"] = res.invoiceId;
    output[key + "Coll"] = res.collectionIds && res.collectionIds.length ? res.collectionIds[0] : "";
    output[key + "Phone"] = phone || "";
    output[key + "PhoneEnc"] = phone ? encodeURIComponent(phone) : "";
    output[key + "Total"] = String(res.total);
    console.log("collections-api sale " + key + ": " + res.invoiceId + " coll=" + output[key + "Coll"]);
  }

  // ---- expect --------------------------------------------------------------
  function expectCheck() {
    var check = env("CHECK", "");
    if (check === "pendingByPayer") {
      var acc = accountId(env("ACCOUNT", ""));
      var payer = env("PAYER", "");
      var parts = Number(env("PARTS", "1"));
      var partSum = env("PART_SUM", "");
      var mine = listCollections("status=pending&accountId=" + acc + "&limit=100").filter(function (c) {
        return c.payerPhoneLast4 === payer;
      });
      if (mine.length !== 1) fail("pendingByPayer: " + mine.length + " pending rows carry payer " + payer + " (want 1)");
      var inv = mine[0].invoiceId;
      var siblings = listCollections("status=pending&invoiceId=" + encodeURIComponent(inv) + "&limit=100");
      if (siblings.length !== parts) fail("pendingByPayer: invoice " + inv + " has " + siblings.length + " pending parts (want " + parts + ")");
      var nos = siblings.map(function (c) { return c.partNo; }).sort();
      for (var i = 0; i < parts; i++) {
        if (nos[i] !== i + 1) fail("pendingByPayer: partNo " + JSON.stringify(nos));
        if (siblings[i].partsCount !== parts) fail("pendingByPayer: partsCount " + siblings[i].partsCount);
      }
      if (partSum) {
        var sum = 0;
        for (var k = 0; k < siblings.length; k++) sum += Math.round(Number(siblings[k].amount) * 100);
        if (sum !== Math.round(Number(partSum) * 100)) fail("pendingByPayer: parts sum " + sum / 100 + " (want " + partSum + ")");
        var sales = must(call("GET", "/api/sales"), [200], "GET sales").data || [];
        var total = 0;
        for (var s = 0; s < sales.length; s++) if (sales[s].invoiceId === inv) total += Math.round(Number(sales[s].totalPrice) * 100);
        if (!(total > sum)) fail("pendingByPayer: invoice total " + total / 100 + " is not above the parts " + sum / 100);
      }
      output.lastInv = inv;
      return;
    }
    if (check === "status") {
      var c = getCollection(env("ID", ""));
      if (c.status !== env("STATUS", "")) fail("status: " + c.id + " is " + c.status + " (want " + env("STATUS", "") + ")");
      return;
    }
    if (check === "ledgerUnpaid" || check === "ledgerPaid") {
      var led = ledger(env("PHONE", ""));
      var want = env("INV", "");
      var hit = null;
      for (var j = 0; j < led.invoices.length; j++) if (led.invoices[j].invoiceId === want) hit = led.invoices[j];
      if (!hit) fail(check + ": invoice " + want + " not in the customer's ledger");
      if (check === "ledgerUnpaid" && !(hit.balance > 0)) fail("ledgerUnpaid: " + want + " balance " + hit.balance);
      if (check === "ledgerPaid" && hit.balance !== 0) fail("ledgerPaid: " + want + " balance " + hit.balance);
      return;
    }
    if (check === "settlementPending") {
      var sacc = accountId(env("ACCOUNT", ""));
      var sphone = digits(env("PHONE", ""));
      var srows = listCollections("status=pending&sourceType=settlement&accountId=" + sacc + "&limit=100").filter(function (c) {
        return digits(c.customerPhone) === sphone;
      });
      if (srows.length < 1) fail("settlementPending: no pending settlement for " + env("PHONE", ""));
      output.sColl = srows[0].id;
      return;
    }
    if (check === "rungAt") {
      var rp = env("PAYER", "");
      var ringAt = Number(env("RING_AT", "0"));
      var minGap = Number(env("MIN_GAP_S", "0"));
      var vrows = listCollections("status=pending&accountId=" + accountId("vf") + "&limit=100").filter(function (c) {
        return c.payerPhoneLast4 === rp;
      });
      if (vrows.length !== 1) fail("rungAt: " + vrows.length + " pending VF rows carry payer " + rp);
      var rung = Date.parse(vrows[0].rungAt);
      if (Math.abs(rung - ringAt) > 30000) fail("rungAt: " + vrows[0].rungAt + " is not the ring time " + new Date(ringAt).toISOString());
      if ((Date.now() - rung) / 1000 < minGap) fail("rungAt: only " + Math.round((Date.now() - rung) / 1000) + " s since the ring (want >= " + minGap + ")");
      return;
    }
    if (check === "noAccount" || check === "accountByLabel") {
      var label = env("LABEL", "");
      var found = listAccounts("?scope=all").filter(function (a) { return a.label === label; });
      if (check === "noAccount") {
        if (found.length !== 0) fail("noAccount: " + found.length + " account(s) labelled " + label);
        return;
      }
      if (found.length !== 1) fail("accountByLabel: " + found.length + " account(s) labelled " + label + " (want 1)");
      output[env("OUT", "accountId")] = found[0].id;
      return;
    }
    if (check === "archived") {
      var aid = env("ID", "");
      var still = listAccounts("?scope=all").filter(function (a) { return a.id === aid; });
      if (still.length !== 0) fail("archived: account " + aid + " is still listed");
      return;
    }
    if (check === "prefsCollections") {
      var prefs = must(call("GET", "/api/notifications/preferences"), [200], "GET notification preferences");
      var types = (prefs.preferences || [])
        .map(function (p) { return p.eventType; })
        .filter(function (e) { return e.indexOf("collection.") === 0; })
        .sort();
      if (JSON.stringify(types) !== JSON.stringify(COLLECTION_EVENTS.slice().sort())) {
        fail("prefsCollections: " + JSON.stringify(types));
      }
      return;
    }
    if (check === "creditByRef") {
      var ref = env("REF", "");
      var cacc = accountId(env("ACCOUNT", ""));
      var credits = must(
        call("GET", "/api/collections/credits?state=held&accountId=" + cacc + "&limit=100"),
        [200],
        "GET credits (held)",
      ).data || [];
      var byRef = credits.filter(function (c) { return c.operatorReference === ref; });
      if (byRef.length !== 1) fail("creditByRef: " + byRef.length + " held credit(s) carry reference " + ref + " (want 1)");
      if (byRef[0].state !== "held" || byRef[0].holdReason !== "manual_source") {
        fail("creditByRef: " + byRef[0].id + " is " + byRef[0].state + "/" + byRef[0].holdReason + " (want held/manual_source)");
      }
      output.cCredit = byRef[0].id;
      return;
    }
    if (check === "creditMatched") {
      var cr = must(call("GET", "/api/collections/credits/" + encodeURIComponent(env("ID", ""))), [200], "GET credit " + env("ID", ""));
      var coll = env("COLL", "");
      if (cr.state !== "matched") fail("creditMatched: " + cr.id + " is " + cr.state + " (want matched)");
      if (!cr.matchedCollection || cr.matchedCollection.id !== coll) {
        fail("creditMatched: matchedCollection " + JSON.stringify(cr.matchedCollection && cr.matchedCollection.id) + " (want " + coll + ")");
      }
      return;
    }
    if (check === "deviceByLabel") {
      var dlabel = env("LABEL", "");
      var dhits = liveDevices().filter(function (d) { return d.label === dlabel; });
      if (dhits.length !== 1) fail("deviceByLabel: " + dhits.length + " live device(s) labelled " + dlabel + " (want 1)");
      output.devId = dhits[0].id;
      return;
    }
    if (check === "deviceSeen" || check === "deviceRevoked") {
      var did = env("ID", "");
      var drow = null;
      var all = listDevices();
      for (var di = 0; di < all.length; di++) if (all[di].id === did) drow = all[di];
      if (check === "deviceSeen") {
        if (!drow) fail("deviceSeen: device " + did + " not listed");
        if (drow.revokedAt) fail("deviceSeen: device " + did + " is revoked");
        if (!drow.lastMessageAt) fail("deviceSeen: device " + did + " has no lastMessageAt");
        return;
      }
      if (drow && !drow.revokedAt) fail("deviceRevoked: device " + did + " is still live");
      return;
    }
    if (check === "noLiveDevice") {
      var since = Number(env("SINCE", "0"));
      var fresh = liveDevices().filter(function (d) { return Date.parse(d.createdAt) >= since; });
      if (fresh.length !== 0) fail("noLiveDevice: " + fresh.length + " live device(s) created since " + new Date(since).toISOString());
      return;
    }
    fail("unknown CHECK " + check);
  }

  // ---- paste (M2) ------------------------------------------------------------
  function paste() {
    var acc = accountId(env("ACCOUNT", "vf"));
    var text = env("TEXT", "") || output.vf1Text || fail("paste: no TEXT and setup did not run with NEED=ingest");
    var body = { text: text };
    if (acc) body.accountId = acc;
    var res = must(
      call("POST", "/api/collections/credits/paste", body, { "Idempotency-Key": "e2e-paste-" + Date.now() + "-" + rand(6) }),
      [200],
      "POST credits/paste",
    );
    var first = res && res.results && res.results[0];
    if (!first || first.status !== "accepted") fail("paste: " + JSON.stringify(res));
    output.pastedCredit = first.creditId || "";
    console.log("collections-api paste: " + first.status + " " + first.state + "/" + first.holdReason + " credit=" + output.pastedCredit);
  }

  // ---- decide --------------------------------------------------------------
  function decide() {
    var action = env("ACTION", "");
    var id = env("ID", "");
    if (["confirm", "reject", "reopen"].indexOf(action) === -1) fail("unknown ACTION " + action);
    var body = {};
    if (action === "reject") {
      body.reason = env("REASON", "not_received");
      body.outcome = env("OUTCOME", "debt");
    }
    var r = call("POST", "/api/collections/" + id + "/" + action, body, { "Idempotency-Key": "e2e-" + action + "-" + id });
    must(r, [200], action + " " + id);
  }

  var mode = env("MODE", "");
  if (mode === "setup") setup();
  else if (mode === "sale") sale();
  else if (mode === "expect") expectCheck();
  else if (mode === "decide") decide();
  else if (mode === "paste") paste();
  else if (mode === "mark") output.ringAt = String(Date.now());
  else fail("unknown MODE " + mode);
})();
