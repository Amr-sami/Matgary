/**
 * Digital collections 05 §4.20 / §4.18 / step 3 (step 9) — the copy and the
 * permission catalogue the clients render.
 *
 * - every value of every domain union 05 §4.20 names has a leaf under
 *   `app.collections.vocab.<group>` in BOTH dictionaries;
 * - every §4.20 error code (and the rest of 03 §B.15's code list, incl. the
 *   five reused codes 07 relies on) has copy under `app.collections.errors`;
 * - the three permission labels + the `collections` group, the activity
 *   category + the 15 actions (flat keys `collection.<x>`, also in
 *   ACTION_LABELS), the `wallet` method labels;
 * - the keys are in ALL_PERMISSIONS and a PERMISSION_GROUPS entry, NOT in
 *   DEFAULT_STAFF_PERMISSIONS; usePermissionCopy.ts and the mobile team
 *   editor name all three (source-read).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COLLECTION_FLAG_VALUES,
  COLLECTION_PROVIDER_VALUES,
  COLLECTION_RAIL_VALUES,
  COLLECTION_SOURCE_TYPE_VALUES,
  COLLECTION_STATUS_VALUES,
  HOLD_REASON_VALUES,
  IGNORE_REASON_VALUES,
  INGEST_CHANNEL_VALUES,
  REJECT_OUTCOME_VALUES,
  REJECT_REASON_VALUES,
} from "@matgary/domain/collections/types";
import {
  ACTION_LABELS,
  ACTIVITY_CATEGORIES,
  CATEGORY_LABELS,
} from "@/lib/activity-labels";
import {
  ALL_PERMISSIONS,
  DEFAULT_STAFF_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
} from "@/lib/permissions";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";

const abs = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), "utf8");
type Dict = Record<string, unknown>;
const dicts: Record<"ar" | "en", Dict> = {
  ar: JSON.parse(read("../../packages/i18n/src/ar.json")),
  en: JSON.parse(read("../../packages/i18n/src/en.json")),
};

/** Walk plain object keys (flat keys like "collection.confirm" are ONE segment). */
function at(dict: Dict, path: string[]): unknown {
  let o: unknown = dict;
  for (const p of path) {
    if (typeof o !== "object" || o === null) return undefined;
    o = (o as Dict)[p];
  }
  return o;
}

function expectLeaf(path: string[]) {
  for (const lang of ["ar", "en"] as const) {
    const v = at(dicts[lang], path);
    expect(typeof v, `${lang}: ${path.join(" › ")}`).toBe("string");
    expect((v as string).trim().length, `${lang}: ${path.join(" › ")} is empty`).toBeGreaterThan(0);
  }
}

const VOCAB: Array<[string, readonly string[]]> = [
  ["status", COLLECTION_STATUS_VALUES],
  ["sourceTypes", COLLECTION_SOURCE_TYPE_VALUES],
  ["reasons", REJECT_REASON_VALUES],
  ["outcomes", REJECT_OUTCOME_VALUES],
  ["rails", COLLECTION_RAIL_VALUES],
  ["providers", COLLECTION_PROVIDER_VALUES],
  ["channels", INGEST_CHANNEL_VALUES],
  ["holdReasons", HOLD_REASON_VALUES],
  ["flags", COLLECTION_FLAG_VALUES],
  ["ignoreReasons", IGNORE_REASON_VALUES],
];

/** 05 §4.20's 26 keys (25 codes + GENERIC). */
const ERRORS_05 = [
  "COLLECTIONS_DISABLED",
  "COLLECTION_NOT_FOUND",
  "COLLECTION_NOT_PENDING",
  "SELF_CONFIRM_FORBIDDEN",
  "REJECT_OUTCOME_REQUIRES_PHONE",
  "REOPEN_WINDOW_CLOSED",
  "REOPEN_BLOCKED_SETTLED",
  "COLLECTION_ACCOUNT_NOT_FOUND",
  "INVALID_IPA_LINK",
  "INVALID_WALLET_NUMBER",
  "INVALID_IBAN",
  "CREDIT_NOT_FOUND",
  "CREDIT_ALREADY_MATCHED",
  "DEVICE_LIMIT_REACHED",
  "INGEST_TOKEN_INVALID",
  "INGEST_DEVICE_REVOKED",
  "INGEST_DISABLED",
  "INGEST_PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "IDEMPOTENCY_KEY_REQUIRED",
  "ACCOUNT_IDENTITY_REQUIRED",
  "PROVIDER_RAIL_MISMATCH",
  "COLLECTION_ACCOUNT_DUPLICATE",
  "COLLECTION_NOT_REOPENABLE",
  "INVALID_REQUEST",
  "GENERIC",
];
/** 03 §B.15's remaining M1/M2 code and the five reused codes ("copy in
 *  app.collections.errors.*"; 07 §10 request 3 relies on them). */
const ERRORS_03 = [
  "CREDIT_NOT_MATCHABLE",
  "DEVICE_NOT_FOUND",
  "NOT_FOUND",
  "FORBIDDEN_BRANCH",
  "TENANT_SUSPENDED",
  "IDEMPOTENCY_MISMATCH",
];

const KEYS = ["view_collections", "confirm_collections", "manage_collection_accounts"] as const;

const ACTIONS = [
  "account_create",
  "account_update",
  "account_archive",
  "settings_update",
  "confirm",
  "reject",
  "reopen",
  "auto_confirm",
  "credit_match",
  "credit_ignore",
  "credit_paste",
  "device_create",
  "device_revoke",
  "raw_view",
  "raw_share",
] as const;

describe("app.collections.vocab — every domain union value, both locales", () => {
  it.each(VOCAB)("%s", (group, values) => {
    for (const v of values) expectLeaf(["app", "collections", "vocab", group, v]);
  });

  it("the vocab subtree holds exactly those groups and values (no strays, ar = en)", () => {
    for (const lang of ["ar", "en"] as const) {
      const vocab = at(dicts[lang], ["app", "collections", "vocab"]) as Dict;
      expect(Object.keys(vocab).sort()).toEqual(VOCAB.map(([g]) => g).sort());
      for (const [g, values] of VOCAB) {
        expect(Object.keys(vocab[g] as Dict).sort(), `${lang} ${g}`).toEqual([...values].sort());
      }
    }
  });

  it("the Arabic rail label for wallets is not the loyalty word alone in method labels", () => {
    // 03 §B.9: the METHOD label is «محفظة موبايل», never bare «محفظة».
    expect(at(dicts.ar, ["app", "catalog", "payment", "wallet"])).toBe("محفظة موبايل");
    expect(at(dicts.en, ["app", "catalog", "payment", "wallet"])).toBe("Mobile wallet");
    expect(at(dicts.ar, ["app", "activityLabels", "paymentMethods", "wallet"])).toBe("محفظة موبايل");
    expect(at(dicts.en, ["app", "activityLabels", "paymentMethods", "wallet"])).toBe("Mobile wallet");
    expect(PAYMENT_METHOD_LABELS.wallet).toBe("محفظة موبايل");
  });
});

describe("app.collections.errors", () => {
  it.each([...ERRORS_05, ...ERRORS_03])("%s has copy in both locales", (code) => {
    expectLeaf(["app", "collections", "errors", code]);
  });

  it("every key is UPPER_SNAKE", () => {
    const errs = at(dicts.en, ["app", "collections", "errors"]) as Dict;
    for (const k of Object.keys(errs)) expect(k).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});

describe("permissions (05 step 3)", () => {
  it("labels + the collections group in both dictionaries", () => {
    for (const k of KEYS) expectLeaf(["app", "permissions", "labels", k]);
    expectLeaf(["app", "permissions", "groups", "collections"]);
  });

  it("in ALL_PERMISSIONS, labelled, in one PERMISSION_GROUPS entry, not in the staff defaults", () => {
    for (const k of KEYS) {
      expect(ALL_PERMISSIONS).toContain(k);
      expect(PERMISSION_LABELS[k]).toBe(at(dicts.ar, ["app", "permissions", "labels", k]));
      expect(PERMISSION_GROUPS.filter((g) => g.permissions.includes(k))).toHaveLength(1);
      expect(DEFAULT_STAFF_PERMISSIONS).not.toContain(k);
    }
    const group = PERMISSION_GROUPS.find((g) => g.permissions.includes("view_collections"))!;
    expect(group.title).toBe(at(dicts.ar, ["app", "permissions", "groups", "collections"]));
    expect(group.permissions).toEqual([...KEYS]);
  });

  it("the web copy hook and the mobile team editor name all three (source-read)", () => {
    const hook = read("components/i18n/usePermissionCopy.ts");
    const team = read("../mobile/src/app/(app)/team/[userId].tsx");
    expect(hook).toContain('titleKey: "collections"');
    expect(team).toContain('t("app.permissions.groups.collections")');
    for (const k of KEYS) {
      expect(hook).toContain(`"${k}"`);
      expect(team).toContain(`"${k}"`);
    }
  });
});

describe("activity log (05 §4.18)", () => {
  it("category `collection` in the type list, the Arabic map and both dictionaries", () => {
    expect(ACTIVITY_CATEGORIES).toContain("collection");
    expect(CATEGORY_LABELS.collection).toBe(at(dicts.ar, ["app", "activityLabels", "categories", "collection"]));
    expectLeaf(["app", "activityLabels", "categories", "collection"]);
  });

  it.each(ACTIONS)("collection.%s — flat dictionary key in both locales + ACTION_LABELS", (a) => {
    const key = `collection.${a}`;
    expectLeaf(["app", "activityLabels", "actions", key]);
    expect(ACTION_LABELS[key]).toBe(at(dicts.ar, ["app", "activityLabels", "actions", key]));
  });

  it("no nested `actions.collection` object (the dot must be escaped when adding)", () => {
    for (const lang of ["ar", "en"] as const) {
      expect(at(dicts[lang], ["app", "activityLabels", "actions", "collection"])).toBeUndefined();
    }
  });
});
