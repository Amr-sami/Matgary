/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/lib/__tests__/activity-details.test.ts
 *
 * `activity-details.ts` imports nothing and takes `t` as a parameter, so plain
 * Node loads it. `t` is mocked as identity: labels come back as the dictionary
 * path (so each assertion pins the exact `app.activityLabels.*` key the row
 * reads) and enum values fall back to the raw value, which is what the real
 * `t` does for a key the dictionary lacks.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { formatActivityDetails, formatNumber, type Translate } from "../activity-details.ts";

const identity: Translate = (path, vars) =>
  // The list separator is the one key whose *value* shapes the output.
  path === "app.activityLabels.listSeparator" ? "، " : vars ? path.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`)) : path;

const F = "app.activityLabels.fields";

test("sale.create: lines are flattened to name (qty × price), numbers grouped, enum falls back raw", () => {
  const out = formatActivityDetails(
    "sale.create",
    {
      invoiceId: "INV-1042",
      productId: "9f1c-should-never-leak",
      lines: [
        { productName: "Pepsi 1L", quantity: 2, pricePerUnit: 15, lineTotal: 30 },
        { productName: "Chips", quantity: 3 },
        { quantity: 1, pricePerUnit: 1234.5 },
      ],
      totalQuantity: 6,
      total: 1264.5,
      paymentMethod: "instapay",
      customerName: "Ahmed",
      note: "",
    },
    identity,
  );
  assert.deepEqual(out, [
    { label: `${F}.invoiceId`, value: "INV-1042" },
    { label: `${F}.lines`, value: "Pepsi 1L (2 × 15)، Chips (3)، — (1 × 1,234.5)" },
    { label: `${F}.totalQuantity`, value: "6" },
    { label: `${F}.total`, value: "1,264.5" },
    { label: `${F}.paymentMethod`, value: "instapay" },
    { label: `${F}.customerName`, value: "Ahmed" },
  ]);
});

test("enum translation: values resolve through app.activityLabels.<group>.<value> when the dictionary has them", () => {
  const dict: Record<string, string> = {
    "app.activityLabels.fields.amount": "المبلغ",
    "app.activityLabels.fields.type": "النوع",
    "app.activityLabels.expenseCategories.electricity": "كهرباء",
    "app.activityLabels.fields.source": "الطريقة",
    "app.activityLabels.attendanceSources.geofence": "تلقائي بالموقع",
    "app.activityLabels.fields.locationAccuracy": "دقة الموقع",
    "app.activityLabels.fields.attemptType": "نوع المحاولة",
    "app.activityLabels.fields.loggedLocation": "الموقع",
    "app.activityLabels.accuracySuffix": "±{n} م",
  };
  const t: Translate = (path, vars) => identity(dict[path] ?? path, vars);

  assert.deepEqual(formatActivityDetails("expense.create", { amount: 2500, category: "electricity" }, t), [
    { label: "المبلغ", value: "2,500" },
    { label: "النوع", value: "كهرباء" },
  ]);
  assert.deepEqual(formatActivityDetails("attendance.check_in", { source: "geofence" }, t), [
    { label: "الطريقة", value: "تلقائي بالموقع" },
  ]);
  // Unknown enum value → raw; accuracy suffix interpolates {n}.
  assert.deepEqual(
    formatActivityDetails(
      "attendance.geofence_rejected",
      { type: "check_in", latitude: 30.04442, longitude: 31.235712, accuracyM: 42.4 },
      t,
    ),
    [
      { label: "نوع المحاولة", value: "check_in" },
      { label: "الموقع", value: "30.044420, 31.235712" },
      { label: "دقة الموقع", value: "±42.4 م" },
    ],
  );
});

test("changed-field lists: fieldNames first, then fields, then the raw key; empty list → no rows", () => {
  const dict: Record<string, string> = {
    "app.activityLabels.fields.changed": "الحقول المعدلة",
    "app.activityLabels.fieldNames.shopName": "اسم المتجر",
    "app.activityLabels.fields.note": "ملاحظة",
  };
  const t: Translate = (path) => dict[path] ?? path;

  assert.deepEqual(
    formatActivityDetails("settings.update", { changed: ["shopName", "note", "mysteryKey"] }, t),
    [{ label: "الحقول المعدلة", value: "اسم المتجر · ملاحظة · mysteryKey" }],
  );
  assert.deepEqual(formatActivityDetails("product.update", { changed: [] }, t), []);
  assert.deepEqual(formatActivityDetails("team.update", null, t), []);
  // Unknown action: only dictionary-labelled keys surface; internal ids never leak.
  assert.deepEqual(formatActivityDetails("sale.void", { note: "returned", saleId: "abc" }, t), [
    { label: "ملاحظة", value: "returned" },
  ]);
});

test("formatNumber: Intl-free grouping with up to 6 fraction digits", () => {
  assert.equal(formatNumber(277575), "277,575");
  assert.equal(formatNumber(-1234.5678901), "-1,234.56789");
  assert.equal(formatNumber(0.1 + 0.2), "0.3");
  assert.equal(formatNumber("x"), "x");
});
