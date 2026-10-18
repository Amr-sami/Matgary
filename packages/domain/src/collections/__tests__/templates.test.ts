// Run: npm test -w @matgary/domain
// Spec 06 §7 templates.test.ts (§4.10 registry, §4.15 promotion rule).
import { test } from "node:test";
import assert from "node:assert/strict";

import { SAMPLES, type SampleFixture } from "../__fixtures__/samples";
import { normalizeSender, normalizeText } from "../normalize";
import { parseMessage } from "../parse";
import { COLLECTION_PROVIDERS } from "../providers";
import { COLLECTION_TEMPLATES, PROMOTION_RULE, templateById } from "../templates/index";
import { VODAFONE_CASH_SMS_CREDIT_V1 } from "../templates/vodafone_cash";
import type { CollectionTemplate } from "../types";

const ALLOWED_GROUPS = new Set([
  "amount", "balance", "payer", "name", "receiving", "hint", "ref", "d1", "d2", "d3", "time", "ampm",
  "counterparty", "datetext", "tail",
]);

function groupsOf(re: RegExp): string[] {
  const out: string[] = [];
  for (const m of re.source.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)) out.push(m[1]);
  return out;
}

test("the seed set: 18 templates in the §4.10 table order, every one published_sample", () => {
  assert.deepEqual(
    COLLECTION_TEMPLATES.map((t) => t.id),
    [
      "vodafone_cash.sms.credit.v1", "vodafone_cash.sms.debit.v1",
      "etisalat_money.sms.credit.v1", "etisalat_money.sms.deposit.v1",
      "orange_cash.sms.credit.v2", "orange_cash.sms.credit.v1", "orange_cash.sms.cash_in.v1",
      "nbe.sms.credit.v1", "nbe.sms.prepaid_credit.v1", "nbe.sms.debit.v1", "nbe.sms.merchant_debit.v1",
      "cib.sms.credit.v1", "cib.sms.debit.v1",
      "qnb.sms.credit.v1", "qnb.sms.debit.v1",
      "bdc.sms.credit.v1", "generic_ipn.sms.credit.v1", "adib.sms.debit.v1",
    ],
  );
  // Acceptance 6: no template is pilot_verified at merge time.
  for (const t of COLLECTION_TEMPLATES) assert.equal(t.status, "published_sample", t.id);
  // Notification templates: none until Q9 samples exist.
  assert.equal(COLLECTION_TEMPLATES.filter((t) => t.channel === "notification").length, 0);
});

test("ids are unique and well-formed; templateById finds each", () => {
  const ids = COLLECTION_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of COLLECTION_TEMPLATES) {
    assert.match(t.id, /^[a-z_]+\.(sms|notification)\.[a-z_]+\.v\d+$/, t.id);
    assert.ok(t.id.endsWith(`.v${t.version}`), t.id);
    assert.ok(t.id.includes(`.${t.channel}.`), t.id);
    assert.equal(templateById(t.id), t);
  }
  assert.equal(templateById("nope.sms.credit.v1"), null);
  assert.equal(templateById("toString"), null);
});

test("regexes: flags exactly `is`, anchored ^…$, only the allowed named groups, `amount` required", () => {
  for (const t of COLLECTION_TEMPLATES) {
    assert.equal(t.regex.flags, "is", t.id);
    assert.ok(t.regex.source.startsWith("^") && t.regex.source.endsWith("$"), t.id);
    const groups = groupsOf(t.regex);
    assert.ok(groups.includes("amount"), `${t.id}: amount`);
    for (const g of groups) assert.ok(ALLOWED_GROUPS.has(g), `${t.id}: group ${g}`);
    assert.equal(new Set(groups).size, groups.length, `${t.id}: one group per name`);
    if (t.direction !== "credit") assert.ok(!groups.includes("name"), `${t.id}: a name on a non-credit`);
  }
});

test("hasBalance ⇔ a balance group; referenceFormat none ⇔ no ref group; dates need d1/d2 + time", () => {
  for (const t of COLLECTION_TEMPLATES) {
    const g = groupsOf(t.regex);
    assert.equal(t.hasBalance, g.includes("balance"), t.id);
    assert.equal(t.referenceFormat === "none", !g.includes("ref"), t.id);
    if (t.dateOrder.length > 0) {
      for (const need of ["d1", "d2", "time"]) assert.ok(g.includes(need), `${t.id}: ${need}`);
      assert.equal(t.hasYear, g.includes("d3"), `${t.id}: hasYear`);
    }
  }
});

test("senderIds come from the provider registry (they never diverge); rails match", () => {
  for (const t of COLLECTION_TEMPLATES) {
    assert.deepEqual([...t.senderIds], [...COLLECTION_PROVIDERS[t.provider].smsSenderIds], t.id);
    assert.equal(t.rail, COLLECTION_PROVIDERS[t.provider].rail, t.id);
    if (t.channel === "sms") assert.deepEqual([...t.packages], [], t.id);
  }
});

test("a template with senderIds [] and every debit / cash_in template has autoConfirm never", () => {
  for (const t of COLLECTION_TEMPLATES) {
    if (t.senderIds.length === 0) assert.equal(t.autoConfirm, "never", t.id);
    if (t.direction !== "credit") assert.equal(t.autoConfirm, "never", t.id);
    if (t.autoConfirm === "balance") assert.ok(t.hasBalance, `${t.id}: balance template without a balance`);
    if (t.autoConfirm === "reference") assert.notEqual(t.referenceFormat, "none", t.id);
  }
});

test("every sampleIds entry is a non-illustrative fixture that parses to that template", () => {
  const byId = new Map(SAMPLES.map((s) => [s.id, s]));
  for (const t of COLLECTION_TEMPLATES) {
    assert.ok(t.sampleIds.length > 0, t.id);
    for (const id of t.sampleIds) {
      const s = byId.get(id);
      assert.ok(s, `${t.id}: ${id} missing`);
      assert.notEqual(s.kind, "illustrative", `${t.id}: ${id}`);
      assert.equal(s.expect.templateId, t.id, `${t.id}: ${id}`);
    }
  }
});

test("no two templates match any fixture (each published fixture matches exactly one)", () => {
  for (const s of SAMPLES) {
    const text = normalizeText(s.text);
    const hits = COLLECTION_TEMPLATES.filter((t) => t.regex.test(text)).map((t) => t.id);
    assert.ok(hits.length <= 1, `${s.id}: ${hits.join(", ")}`);
    if (s.kind === "published") assert.deepEqual(hits, [s.expect.templateId], s.id);
    else assert.deepEqual(hits, [], s.id);
  }
});

// --- §4.15 promotion rule -----------------------------------------------------

/** Every reason a pilot_verified template fails §4.15 steps 1–3 (empty = OK). */
function promotionProblems(t: CollectionTemplate, samples: readonly SampleFixture[]): string[] {
  const problems: string[] = [];
  if (t.status !== "pilot_verified") return problems;
  const pilots = t.sampleIds
    .map((id) => samples.find((s) => s.id === id))
    .filter((s): s is SampleFixture => !!s && s.kind === "pilot");
  if (pilots.length < PROMOTION_RULE.minPilotSamples) problems.push(`only ${pilots.length} pilot samples`);
  const phones = new Set(pilots.map((s) => s.pilot?.phoneId).filter(Boolean));
  if (phones.size < PROMOTION_RULE.minDistinctPhones) problems.push(`only ${phones.size} distinct phones`);
  for (const s of pilots) {
    if (!s.pilot) {
      problems.push(`${s.id}: no pilot block`);
      continue;
    }
    if (t.channel === "sms") {
      const observed = normalizeSender(s.pilot.observedSender);
      if (!t.senderIds.some((id) => normalizeSender(id) === observed)) problems.push(`${s.id}: sender not observed`);
    } else if (!s.pilot.observedPackage || t.packages.indexOf(s.pilot.observedPackage) === -1) {
      problems.push(`${s.id}: package not observed`);
    }
    const r = parseMessage(
      { channel: s.channel, sender: s.sender, sourceApp: s.sourceApp, body: s.text, receivedAt: s.receivedAt },
      { now: new Date(s.receivedAt), templates: [t] },
    );
    if (r.templateId !== t.id) problems.push(`${s.id}: does not parse to ${t.id}`);
  }
  if (t.direction === "credit" && t.autoConfirm === "never") problems.push("promoted credit template never auto-confirms");
  return problems;
}

test("every pilot_verified template satisfies PROMOTION_RULE (vacuous until the first Q9 promotion)", () => {
  assert.deepEqual(PROMOTION_RULE, { minPilotSamples: 3, minDistinctPhones: 2 });
  for (const t of COLLECTION_TEMPLATES) assert.deepEqual(promotionProblems(t, SAMPLES), [], t.id);
});

test("the promotion checker catches a premature promotion (self-test)", () => {
  const vf1 = SAMPLES.find((s) => s.id === "VF-1") as SampleFixture;
  const pilot = (id: string, phoneId: string): SampleFixture => ({
    ...vf1,
    id,
    kind: "pilot",
    pilot: { phoneId, observedSender: "vf-cash", observedPackage: null, capturedAt: vf1.receivedAt },
  });
  const promoted: CollectionTemplate = { ...VODAFONE_CASH_SMS_CREDIT_V1, status: "pilot_verified" };
  // Published sample only → fails.
  assert.ok(promotionProblems(promoted, SAMPLES).length > 0);
  // Three pilots from one phone → fails on phones.
  const onePhone = [pilot("PILOT-vodafone_cash-1", "P1"), pilot("PILOT-vodafone_cash-2", "P1"), pilot("PILOT-vodafone_cash-3", "P1")];
  const t1 = { ...promoted, sampleIds: onePhone.map((s) => s.id) };
  assert.deepEqual(promotionProblems(t1, onePhone), ["only 1 distinct phones"]);
  // Three pilots from two phones → passes.
  const twoPhones = [onePhone[0], onePhone[1], pilot("PILOT-vodafone_cash-3", "P2")];
  assert.deepEqual(promotionProblems({ ...promoted, sampleIds: twoPhones.map((s) => s.id) }, twoPhones), []);
  // A sender never observed → fails.
  const spoofed = twoPhones.map((s) => ({ ...s, pilot: { ...(s.pilot as NonNullable<SampleFixture["pilot"]>), observedSender: "1234" } }));
  assert.ok(promotionProblems({ ...promoted, sampleIds: spoofed.map((s) => s.id) }, spoofed).some((p) => p.includes("sender")));
  // A promoted credit template with autoConfirm never → fails.
  assert.ok(
    promotionProblems({ ...promoted, autoConfirm: "never", sampleIds: twoPhones.map((s) => s.id) }, twoPhones).some((p) =>
      p.includes("never"),
    ),
  );
});
