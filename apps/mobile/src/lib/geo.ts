/**
 * Pure geodesy for the attendance geofence. No React, no Expo, no Intl — plain
 * math so Node can unit-test it (`node --test --experimental-strip-types
 * apps/mobile/src/lib/__tests__/geo.test.ts`) and so the phone computes the
 * SAME number the server does: this is a port of `haversineMeters` in
 * apps/web/app/api/attendance/self/route.ts. If the two ever disagree the app
 * would tell the user "inside range" and the server would 403 them.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface GeofenceLocation extends LatLng {
  id: string;
  name: string;
  geofenceRadiusM: number;
}

/** Mean Earth radius in metres — same constant as the server. */
const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in metres (haversine). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

export interface GeofenceCheck<L extends GeofenceLocation = GeofenceLocation> {
  /** The location whose fence the point is closest to satisfying. */
  nearest: L;
  /** Metres from the point to `nearest`. */
  distanceM: number;
  /** Positive when inside: how much room is left before the fence. */
  marginM: number;
  /** `distanceM <= nearest.geofenceRadiusM` — exactly the server's rule. */
  inside: boolean;
}

/**
 * Which store location the point is closest to (relative to each fence's
 * radius), and whether the server would accept a geofence check-in from it.
 *
 * "Closest" is measured by margin (radius − distance), not raw distance: a
 * point 150 m from a 200 m fence beats a point 100 m from a 50 m fence, since
 * the first one is accepted and the second is not. Returns null when there are
 * no locations — the server answers 409 for that case and the UI says so.
 */
export function evaluateGeofence<L extends GeofenceLocation>(
  point: LatLng,
  locations: readonly L[],
): GeofenceCheck<L> | null {
  let best: GeofenceCheck<L> | null = null;
  for (const loc of locations) {
    const distanceM = haversineMeters(point, loc);
    const marginM = loc.geofenceRadiusM - distanceM;
    if (!best || marginM > best.marginM) {
      best = { nearest: loc, distanceM, marginM, inside: marginM >= 0 };
    }
  }
  return best;
}

/**
 * A GPS fix is "usable" for the fence when its error circle is not bigger
 * than the fence itself. Doc 02 §3.2 asks the server to reject on this too;
 * until it does, the app warns rather than blocks.
 */
export function accuracyExceedsRadius(
  accuracyM: number | null | undefined,
  radiusM: number,
): boolean {
  return accuracyM != null && Number.isFinite(accuracyM) && accuracyM > radiusM;
}

/**
 * "120 m" / "1.4 km" — Latin digits, no Intl (Hermes ICU is trimmed; see
 * src/lib/format.ts). Under 1 km rounds to the metre; above it, one decimal.
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  const s = km >= 100 ? String(Math.round(km)) : km.toFixed(1).replace(/\.0$/, "");
  return `${s} km`;
}

/** Server zod wants `accuracyM` as a non-negative integer or null. */
export function toAccuracyM(accuracy: number | null | undefined): number | null {
  if (accuracy == null || !Number.isFinite(accuracy) || accuracy < 0) return null;
  return Math.round(accuracy);
}
