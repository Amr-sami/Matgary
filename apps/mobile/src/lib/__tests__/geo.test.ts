/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/lib/__tests__/geo.test.ts
 *
 * `geo.ts` imports nothing, so plain Node loads it. The reference distances
 * come from the same formula the server uses (apps/web/app/api/attendance/self/route.ts).
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// Node's type-stripping loader needs the explicit `.ts` extension; the Expo
// tsconfig has no `allowImportingTsExtensions`, so silence that one check —
// Metro never bundles this file and tsc still checks everything it imports.
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { accuracyExceedsRadius, evaluateGeofence, formatDistance, haversineMeters, toAccuracyM } from "../geo.ts";

// Tahrir Square, Cairo — the coordinates the web's settings placeholder shows.
const TAHRIR = { latitude: 30.04442, longitude: 31.235712 };

test("haversine: identical points are 0 m", () => {
  assert.equal(haversineMeters(TAHRIR, TAHRIR), 0);
});

test("haversine: ~111.2 km per degree of latitude at the equator", () => {
  const d = haversineMeters(
    { latitude: 0, longitude: 0 },
    { latitude: 1, longitude: 0 },
  );
  assert.ok(Math.abs(d - 111_195) < 10, `got ${d}`);
});

test("haversine: symmetric", () => {
  const b = { latitude: 30.0500, longitude: 31.2400 };
  assert.equal(haversineMeters(TAHRIR, b), haversineMeters(b, TAHRIR));
});

test("haversine: 0.001° north of Tahrir is ~111 m", () => {
  const d = haversineMeters(TAHRIR, { ...TAHRIR, latitude: TAHRIR.latitude + 0.001 });
  assert.ok(d > 110 && d < 112, `got ${d}`);
});

test("haversine: 0.001° east at 30°N is ~96 m (cos φ shrinks longitude)", () => {
  const d = haversineMeters(TAHRIR, { ...TAHRIR, longitude: TAHRIR.longitude + 0.001 });
  assert.ok(d > 95 && d < 97.5, `got ${d}`);
});

test("haversine: antipodal points do not NaN (asin clamp)", () => {
  const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
  assert.ok(Number.isFinite(d));
  assert.ok(Math.abs(d - Math.PI * 6_371_000) < 1);
});

const SHOP = { id: "a", name: "الفرع الرئيسي", ...TAHRIR, geofenceRadiusM: 200 };
const WAREHOUSE = {
  id: "b",
  name: "المخزن",
  latitude: 30.0600,
  longitude: 31.2500,
  geofenceRadiusM: 50,
};

test("evaluateGeofence: no locations → null", () => {
  assert.equal(evaluateGeofence(TAHRIR, []), null);
});

test("evaluateGeofence: standing in the shop is inside", () => {
  const r = evaluateGeofence(TAHRIR, [SHOP, WAREHOUSE]);
  assert.ok(r);
  assert.equal(r.nearest.id, "a");
  assert.equal(r.inside, true);
  assert.equal(r.distanceM, 0);
  assert.equal(r.marginM, 200);
});

test("evaluateGeofence: 120 m from a 200 m fence is inside with 80 m to spare", () => {
  const point = { ...TAHRIR, latitude: TAHRIR.latitude + 0.00108 }; // ≈120 m
  const r = evaluateGeofence(point, [SHOP]);
  assert.ok(r);
  assert.equal(r.inside, true);
  assert.ok(r.distanceM > 118 && r.distanceM < 122, `got ${r.distanceM}`);
  assert.ok(Math.abs(r.marginM - (200 - r.distanceM)) < 1e-9);
});

test("evaluateGeofence: 250 m from a 200 m fence is outside — same rule as the server", () => {
  const point = { ...TAHRIR, latitude: TAHRIR.latitude + 0.00225 }; // ≈250 m
  const r = evaluateGeofence(point, [SHOP]);
  assert.ok(r);
  assert.equal(r.inside, false);
  assert.ok(r.marginM < 0);
});

test("evaluateGeofence: exactly on the fence counts as inside (<=)", () => {
  // Build a point whose distance is exactly the radius by scaling.
  const north = { ...TAHRIR, latitude: TAHRIR.latitude + 0.001 };
  const dPerDeg = haversineMeters(TAHRIR, north) / 0.001;
  const point = { ...TAHRIR, latitude: TAHRIR.latitude + 200 / dPerDeg };
  const r = evaluateGeofence(point, [SHOP]);
  assert.ok(r);
  assert.ok(Math.abs(r.distanceM - 200) < 1e-6, `got ${r.distanceM}`);
  assert.equal(r.inside, r.distanceM <= 200);
});

test("evaluateGeofence: picks by margin, not raw distance", () => {
  // 40 m from the warehouse (50 m fence → +10 margin) but 150 m from the shop
  // (200 m fence → +50 margin): the shop is the better fence even though the
  // warehouse is physically nearer.
  const nearWarehouse = {
    latitude: WAREHOUSE.latitude + 0.00036,
    longitude: WAREHOUSE.longitude,
  };
  const shopClose = { ...SHOP, latitude: WAREHOUSE.latitude + 0.00171, longitude: WAREHOUSE.longitude };
  const r = evaluateGeofence(nearWarehouse, [WAREHOUSE, shopClose]);
  assert.ok(r);
  assert.equal(r.nearest.id, "a");
  assert.equal(r.inside, true);
});

test("evaluateGeofence: outside every fence still reports the least-bad one", () => {
  const far = { latitude: 31.2, longitude: 29.9 }; // Alexandria
  const r = evaluateGeofence(far, [SHOP, WAREHOUSE]);
  assert.ok(r);
  assert.equal(r.inside, false);
  // Whichever fence has the least-negative margin wins — verified against the
  // raw formula rather than a hard-coded id so the fixture can move.
  const best = [SHOP, WAREHOUSE]
    .map((l) => ({ id: l.id, margin: l.geofenceRadiusM - haversineMeters(far, l) }))
    .sort((x, y) => y.margin - x.margin)[0];
  assert.equal(r.nearest.id, best.id);
  assert.ok(Math.abs(r.marginM - best.margin) < 1e-9);
});

test("accuracyExceedsRadius", () => {
  assert.equal(accuracyExceedsRadius(null, 200), false);
  assert.equal(accuracyExceedsRadius(undefined, 200), false);
  assert.equal(accuracyExceedsRadius(NaN, 200), false);
  assert.equal(accuracyExceedsRadius(50, 200), false);
  assert.equal(accuracyExceedsRadius(200, 200), false);
  assert.equal(accuracyExceedsRadius(201, 200), true);
});

test("formatDistance", () => {
  assert.equal(formatDistance(0), "0 m");
  assert.equal(formatDistance(119.6), "120 m");
  assert.equal(formatDistance(999.4), "999 m");
  assert.equal(formatDistance(1000), "1 km");
  assert.equal(formatDistance(1440), "1.4 km");
  assert.equal(formatDistance(123_456), "123 km");
  assert.equal(formatDistance(999.6), "1 km", "rounds up into the km branch, never '1000 m'");
  assert.equal(formatDistance(11_990_000), "11,990 km", "grouped like every amount in the app");
  assert.equal(formatDistance(-5), "—");
  assert.equal(formatDistance(NaN), "—");
});

test("formatDistance: the unit comes from the dictionary when t is passed", () => {
  const ar: Record<string, string> = { "mobile.units.meters": "{n} م", "mobile.units.km": "{n} كم" };
  const t = (path: string, vars?: Record<string, string | number>) =>
    (ar[path] ?? path).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k]));
  assert.equal(formatDistance(0, t), "0 م");
  assert.equal(formatDistance(119.6, t), "120 م");
  assert.equal(formatDistance(1440, t), "1.4 كم");
  assert.equal(formatDistance(11_990_000, t), "11,990 كم");
  assert.equal(formatDistance(NaN, t), "—");
});

test("toAccuracyM: integer or null, as the zod schema wants", () => {
  assert.equal(toAccuracyM(12.4), 12);
  assert.equal(toAccuracyM(12.6), 13);
  assert.equal(toAccuracyM(0), 0);
  assert.equal(toAccuracyM(null), null);
  assert.equal(toAccuracyM(undefined), null);
  assert.equal(toAccuracyM(-1), null);
  assert.equal(toAccuracyM(Infinity), null);
});
