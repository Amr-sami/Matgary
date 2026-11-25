// Phase 2 — Platform-wide + per-tenant presence and activity aggregates.
//
// Every count here is EXACT across the full user/device universe. No sampling,
// no first-N slices, no client-side joins. Each query is a single SQL round-
// trip; indexes cover the hot predicates (see migration 0063).
//
// Timezone semantics (ONE canonical rule):
//   • Activity timestamps are stored UTC (`timestamptz`).
//   • DAU uses the calendar day in REPORTING_TZ.
//     Boundary: `date_trunc('day', now() AT TIME ZONE $tz)` → start of today.
//   • WAU uses a rolling 7-day window: (now − 7 days, now].
//   • MAU uses a rolling 30-day window: (now − 30 days, now].
//   Rolling windows don't depend on TZ (7 × 24h is 7 × 24h everywhere); only
//   calendar-day cuts do, which is why only DAU reads REPORTING_TZ.
//
// "Activity" for DAU/WAU/MAU means:
//   • an `activity_logs` row whose `actor_user_id` is non-null (every write
//     path in the tenant app emits one), OR
//   • a presence heartbeat (`web_live_sessions.last_activity_at` or
//     `auth_devices.last_used_at`) — which effectively covers read paths too
//     via the requireTenant chokepoint.
// The UNION is deduplicated on user_id so a user who both wrote a sale AND
// loaded a page counts once.
//
// Online definition — the ONLY definition, used everywhere:
//   online_now = user with any heartbeat in the last ONLINE_WINDOW_MS.

import { sql } from "drizzle-orm";
import { getAdminDb } from "./db";
import {
  ACTIVE_15M_MS,
  ACTIVE_5M_MS,
  ONLINE_WINDOW_MS,
  REPORTING_TZ,
} from "./presence";

// ─── Public shapes ──────────────────────────────────────────────────────────

export interface PresenceSnapshot {
  onlineNow: number;
  active5m: number;
  active15m: number;
  activeToday: number;
  dau: number;
  wau: number;
  mau: number;
  /** Distinct users with a heartbeat in the online window, grouped by
   *  platform. 'ios' + 'android' come from auth_devices; 'web' + 'other'
   *  from web_live_sessions. A user with both a phone and a browser online
   *  is counted once per platform they appear in — the Overview UI shows
   *  the per-platform numbers separately. */
  byPlatform: {
    ios: number;
    android: number;
    web: number;
    other: number;
  };
}

export interface DeviceAnalytics {
  activeDevicesNow: number;
  activeDevicesToday: number;
  installsToday: number;
  installsThisWeek: number;
  installsThisMonth: number;
  byPlatform: {
    ios: number;
    android: number;
    web: number;
    other: number;
  };
  /** Install registrations per calendar day (REPORTING_TZ) for the last 90
   *  days, dense (missing days zero-filled by the SQL). */
  installsLast90d: { day: string; count: number }[];
  /** App-version distribution for ACTIVE (non-revoked, used within 30d)
   *  mobile devices, grouped by (platform, appVersion), ordered by count. */
  appVersionDistribution: {
    platform: string;
    appVersion: string;
    count: number;
  }[];
}

export interface StoreActivityDigest {
  /** Stores with ≥1 active user (heartbeat OR activity log) in the window. */
  activeToday: number;
  active7d: number;
  active30d: number;
  /** Stores that recorded ≥1 sale in the window — distinct from "active"
   *  because a store can be active (owner logs in, checks reports) without
   *  selling. Both numbers matter: "active" measures engagement, "sales-
   *  active" measures business output. */
  salesActiveToday: number;
  salesActive7d: number;
  salesActive30d: number;
  inactive7d: number;
  inactive14d: number;
  inactive30d: number;
  /** Distinct active stores per calendar day (REPORTING_TZ), last 30 days. */
  activityTrend30d: { day: string; stores: number }[];
}

export interface TenantPresenceDetail {
  /** Users currently online in this tenant (5-min window). */
  onlineNow: number;
  /** Any activity in last 24 h (users). */
  activeToday: number;
  /** Devices (auth_devices) currently flagged as active. */
  activeDevices: number;
  /** Platform split within this tenant's online users. */
  byPlatform: { ios: number; android: number; web: number; other: number };
  /** Hourly online-user count for the last 24 h, UTC-bucketed. */
  activityLast24h: { hour: string; users: number }[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Turn a numeric Postgres aggregate result into a safe integer. Drizzle
 *  returns numeric strings from COUNT(DISTINCT) in some driver flavours. */
function num(x: unknown): number {
  if (x == null) return 0;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function pickRows<T>(r: unknown): T[] {
  return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

const onlineSeconds = Math.round(ONLINE_WINDOW_MS / 1000);
const active5mSeconds = Math.round(ACTIVE_5M_MS / 1000);
const active15mSeconds = Math.round(ACTIVE_15M_MS / 1000);

// ─── Platform-wide presence snapshot ────────────────────────────────────────

/**
 * Exact platform-wide presence + active-user KPIs. One parallel query
 * fan-out; nothing sampled.
 *
 *   online_now / 5m / 15m    distinct(users) with heartbeat < threshold
 *   activeToday               distinct(users) with activity ≥ today-start
 *   DAU / WAU / MAU           distinct(users) with ANY activity in window
 *   byPlatform                distinct(users) per platform in online window
 *
 * Union logic for active-user windows combines heartbeats AND activity_logs.
 */
export async function getPlatformPresence(
  now: Date = new Date(),
): Promise<PresenceSnapshot> {
  const db = getAdminDb();
  const nowIso = now.toISOString();
  const tz = REPORTING_TZ;

  type CountRow = { c: number | string };
  type PlatformRow = { platform: string; c: number | string };

  const [online, a5m, a15m, today, dau, wau, mau, byPlatformMobile, byPlatformWeb] =
    await Promise.all([
      // online_now — union of both heartbeat sources, distinct user_id
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS c FROM (
          SELECT user_id FROM auth_devices
            WHERE revoked_at IS NULL
              AND last_used_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
          UNION ALL
          SELECT user_id FROM web_live_sessions
            WHERE last_activity_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
        ) u
      `) as unknown as Promise<CountRow[]>,
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS c FROM (
          SELECT user_id FROM auth_devices
            WHERE revoked_at IS NULL
              AND last_used_at > ${nowIso}::timestamptz - make_interval(secs => ${active5mSeconds})
          UNION ALL
          SELECT user_id FROM web_live_sessions
            WHERE last_activity_at > ${nowIso}::timestamptz - make_interval(secs => ${active5mSeconds})
        ) u
      `) as unknown as Promise<CountRow[]>,
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS c FROM (
          SELECT user_id FROM auth_devices
            WHERE revoked_at IS NULL
              AND last_used_at > ${nowIso}::timestamptz - make_interval(secs => ${active15mSeconds})
          UNION ALL
          SELECT user_id FROM web_live_sessions
            WHERE last_activity_at > ${nowIso}::timestamptz - make_interval(secs => ${active15mSeconds})
        ) u
      `) as unknown as Promise<CountRow[]>,
      // activeToday — ≥ start of today in REPORTING_TZ.
      // Union heartbeats + activity_logs, distinct user_id.
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS c FROM (
          SELECT user_id FROM auth_devices
            WHERE revoked_at IS NULL
              AND last_used_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
          UNION ALL
          SELECT user_id FROM web_live_sessions
            WHERE last_activity_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
          UNION ALL
          SELECT actor_user_id AS user_id FROM activity_logs
            WHERE actor_user_id IS NOT NULL
              AND created_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
        ) u
      `) as unknown as Promise<CountRow[]>,
      // DAU — same as activeToday. Alias kept for the API's clarity.
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS c FROM (
          SELECT user_id FROM auth_devices
            WHERE revoked_at IS NULL
              AND last_used_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
          UNION ALL
          SELECT user_id FROM web_live_sessions
            WHERE last_activity_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
          UNION ALL
          SELECT actor_user_id FROM activity_logs
            WHERE actor_user_id IS NOT NULL
              AND created_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
        ) u
      `) as unknown as Promise<CountRow[]>,
      // WAU — rolling (now − 7 days, now].
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS c FROM (
          SELECT user_id FROM auth_devices
            WHERE revoked_at IS NULL
              AND last_used_at > ${nowIso}::timestamptz - INTERVAL '7 days'
          UNION ALL
          SELECT user_id FROM web_live_sessions
            WHERE last_activity_at > ${nowIso}::timestamptz - INTERVAL '7 days'
          UNION ALL
          SELECT actor_user_id FROM activity_logs
            WHERE actor_user_id IS NOT NULL
              AND created_at > ${nowIso}::timestamptz - INTERVAL '7 days'
        ) u
      `) as unknown as Promise<CountRow[]>,
      // MAU — rolling (now − 30 days, now].
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS c FROM (
          SELECT user_id FROM auth_devices
            WHERE revoked_at IS NULL
              AND last_used_at > ${nowIso}::timestamptz - INTERVAL '30 days'
          UNION ALL
          SELECT user_id FROM web_live_sessions
            WHERE last_activity_at > ${nowIso}::timestamptz - INTERVAL '30 days'
          UNION ALL
          SELECT actor_user_id FROM activity_logs
            WHERE actor_user_id IS NOT NULL
              AND created_at > ${nowIso}::timestamptz - INTERVAL '30 days'
        ) u
      `) as unknown as Promise<CountRow[]>,
      // Mobile platform split in the online window — group by auth_devices.platform.
      db.execute(sql`
        SELECT COALESCE(platform, 'other') AS platform, COUNT(DISTINCT user_id)::int AS c
        FROM auth_devices
        WHERE revoked_at IS NULL
          AND last_used_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
        GROUP BY COALESCE(platform, 'other')
      `) as unknown as Promise<PlatformRow[]>,
      // Web/other split — auth_devices never writes 'web' from the mobile
      // client under normal flow, so we read web sessions from the web
      // table to avoid double-counting.
      db.execute(sql`
        SELECT platform, COUNT(DISTINCT user_id)::int AS c
        FROM web_live_sessions
        WHERE last_activity_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
        GROUP BY platform
      `) as unknown as Promise<PlatformRow[]>,
    ]);

  const platformMap = { ios: 0, android: 0, web: 0, other: 0 };
  for (const r of pickRows<PlatformRow>(byPlatformMobile)) {
    const p = r.platform;
    if (p === "ios" || p === "android" || p === "web") platformMap[p] += num(r.c);
    else platformMap.other += num(r.c);
  }
  for (const r of pickRows<PlatformRow>(byPlatformWeb)) {
    const p = r.platform;
    if (p === "web") platformMap.web += num(r.c);
    else platformMap.other += num(r.c);
  }

  return {
    onlineNow: num(pickRows<CountRow>(online)[0]?.c),
    active5m: num(pickRows<CountRow>(a5m)[0]?.c),
    active15m: num(pickRows<CountRow>(a15m)[0]?.c),
    activeToday: num(pickRows<CountRow>(today)[0]?.c),
    dau: num(pickRows<CountRow>(dau)[0]?.c),
    wau: num(pickRows<CountRow>(wau)[0]?.c),
    mau: num(pickRows<CountRow>(mau)[0]?.c),
    byPlatform: platformMap,
  };
}

// ─── Platform-wide device + install analytics ───────────────────────────────

/**
 * Device + install analytics.
 *
 * "Installation" is defined as a non-revoked `auth_devices` row with a
 * non-null `install_id`. Rows without an install_id (legacy and some web
 * entries) are counted as active devices but NOT as installations — we
 * refuse to inflate historical data.
 *
 * "Active device" = non-revoked and used within the online window (5m).
 */
export async function getDeviceAnalytics(
  now: Date = new Date(),
): Promise<DeviceAnalytics> {
  const db = getAdminDb();
  const nowIso = now.toISOString();
  const tz = REPORTING_TZ;

  type CountRow = { c: number | string };
  type PlatformRow = { platform: string; c: number | string };
  type DayRow = { day: string; c: number | string };
  type VersionRow = {
    platform: string;
    app_version: string;
    c: number | string;
  };

  const [
    activeNow,
    activeToday,
    newToday,
    newThisWeek,
    newThisMonth,
    byPlatform,
    trend,
    versions,
  ] = await Promise.all([
    db.execute(sql`
      SELECT COUNT(*)::int AS c FROM auth_devices
      WHERE revoked_at IS NULL
        AND last_used_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
    `) as unknown as Promise<CountRow[]>,
    db.execute(sql`
      SELECT COUNT(*)::int AS c FROM auth_devices
      WHERE revoked_at IS NULL
        AND last_used_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
    `) as unknown as Promise<CountRow[]>,
    db.execute(sql`
      SELECT COUNT(*)::int AS c FROM auth_devices
      WHERE install_id IS NOT NULL
        AND revoked_at IS NULL
        AND created_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
    `) as unknown as Promise<CountRow[]>,
    db.execute(sql`
      SELECT COUNT(*)::int AS c FROM auth_devices
      WHERE install_id IS NOT NULL
        AND revoked_at IS NULL
        AND created_at > ${nowIso}::timestamptz - INTERVAL '7 days'
    `) as unknown as Promise<CountRow[]>,
    db.execute(sql`
      SELECT COUNT(*)::int AS c FROM auth_devices
      WHERE install_id IS NOT NULL
        AND revoked_at IS NULL
        AND created_at > ${nowIso}::timestamptz - INTERVAL '30 days'
    `) as unknown as Promise<CountRow[]>,
    db.execute(sql`
      SELECT COALESCE(platform, 'other') AS platform, COUNT(*)::int AS c
      FROM auth_devices
      WHERE revoked_at IS NULL
      GROUP BY COALESCE(platform, 'other')
    `) as unknown as Promise<PlatformRow[]>,
    // Dense 90-day install trend — generate_series left-join so missing
    // days zero-fill. Grouped by REPORTING_TZ day boundary.
    db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) - INTERVAL '89 days',
          date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}),
          INTERVAL '1 day'
        ) AS day_bucket
      ),
      buckets AS (
        SELECT date_trunc('day', created_at AT TIME ZONE ${tz}) AS day_bucket,
               COUNT(*) AS c
        FROM auth_devices
        WHERE install_id IS NOT NULL
          AND revoked_at IS NULL
          AND created_at > ${nowIso}::timestamptz - INTERVAL '90 days'
        GROUP BY 1
      )
      SELECT to_char(days.day_bucket, 'YYYY-MM-DD') AS day,
             COALESCE(buckets.c, 0)::int AS c
      FROM days
      LEFT JOIN buckets ON buckets.day_bucket = days.day_bucket
      ORDER BY days.day_bucket ASC
    `) as unknown as Promise<DayRow[]>,
    db.execute(sql`
      SELECT COALESCE(platform, 'other') AS platform,
             COALESCE(app_version, 'unknown') AS app_version,
             COUNT(*)::int AS c
      FROM auth_devices
      WHERE revoked_at IS NULL
        AND last_used_at > ${nowIso}::timestamptz - INTERVAL '30 days'
      GROUP BY COALESCE(platform, 'other'), COALESCE(app_version, 'unknown')
      ORDER BY c DESC
      LIMIT 20
    `) as unknown as Promise<VersionRow[]>,
  ]);

  const platformMap = { ios: 0, android: 0, web: 0, other: 0 };
  for (const r of pickRows<PlatformRow>(byPlatform)) {
    const p = r.platform;
    if (p === "ios" || p === "android" || p === "web") platformMap[p] += num(r.c);
    else platformMap.other += num(r.c);
  }

  return {
    activeDevicesNow: num(pickRows<CountRow>(activeNow)[0]?.c),
    activeDevicesToday: num(pickRows<CountRow>(activeToday)[0]?.c),
    installsToday: num(pickRows<CountRow>(newToday)[0]?.c),
    installsThisWeek: num(pickRows<CountRow>(newThisWeek)[0]?.c),
    installsThisMonth: num(pickRows<CountRow>(newThisMonth)[0]?.c),
    byPlatform: platformMap,
    installsLast90d: pickRows<DayRow>(trend).map((r) => ({
      day: r.day,
      count: num(r.c),
    })),
    appVersionDistribution: pickRows<VersionRow>(versions).map((r) => ({
      platform: r.platform,
      appVersion: r.app_version,
      count: num(r.c),
    })),
  };
}

// ─── Store (tenant) activity rollup ─────────────────────────────────────────

export async function getStoreActivityDigest(
  now: Date = new Date(),
): Promise<StoreActivityDigest> {
  const db = getAdminDb();
  const nowIso = now.toISOString();
  const tz = REPORTING_TZ;

  type CountRow = { c: number | string };
  type DayRow = { day: string; c: number | string };

  // "Active store" today/7d/30d — distinct tenant_id with heartbeat or
  // activity_logs in the window.
  const activeSql = (interval: string) => sql`
    SELECT COUNT(DISTINCT tenant_id)::int AS c FROM (
      SELECT tenant_id FROM auth_devices
        WHERE revoked_at IS NULL
          AND last_used_at > ${nowIso}::timestamptz - INTERVAL ${sql.raw(`'${interval}'`)}
      UNION ALL
      SELECT tenant_id FROM web_live_sessions
        WHERE last_activity_at > ${nowIso}::timestamptz - INTERVAL ${sql.raw(`'${interval}'`)}
      UNION ALL
      SELECT tenant_id FROM activity_logs
        WHERE created_at > ${nowIso}::timestamptz - INTERVAL ${sql.raw(`'${interval}'`)}
    ) u
  `;
  const activeTodayTzSql = sql`
    SELECT COUNT(DISTINCT tenant_id)::int AS c FROM (
      SELECT tenant_id FROM auth_devices
        WHERE revoked_at IS NULL
          AND last_used_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
      UNION ALL
      SELECT tenant_id FROM web_live_sessions
        WHERE last_activity_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
      UNION ALL
      SELECT tenant_id FROM activity_logs
        WHERE created_at >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
    ) u
  `;

  // Sales-active stores: distinct tenant_id with ≥1 sale in the window.
  // No join to auth/heartbeat tables — sales table is authoritative for
  // business activity.
  const salesSql = (interval: string) => sql`
    SELECT COUNT(DISTINCT tenant_id)::int AS c FROM sales
    WHERE sale_date > ${nowIso}::timestamptz - INTERVAL ${sql.raw(`'${interval}'`)}
  `;
  const salesTodayTzSql = sql`
    SELECT COUNT(DISTINCT tenant_id)::int AS c FROM sales
    WHERE sale_date >= date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
  `;

  // Inactive stores: total stores − active in window.
  const inactiveSql = (interval: string) => sql`
    SELECT COUNT(*)::int AS c FROM tenants
    WHERE id NOT IN (
      SELECT tenant_id FROM auth_devices
        WHERE revoked_at IS NULL
          AND last_used_at > ${nowIso}::timestamptz - INTERVAL ${sql.raw(`'${interval}'`)}
      UNION ALL
      SELECT tenant_id FROM web_live_sessions
        WHERE last_activity_at > ${nowIso}::timestamptz - INTERVAL ${sql.raw(`'${interval}'`)}
      UNION ALL
      SELECT tenant_id FROM activity_logs
        WHERE created_at > ${nowIso}::timestamptz - INTERVAL ${sql.raw(`'${interval}'`)}
    )
  `;

  const [
    activeToday,
    active7d,
    active30d,
    salesToday,
    sales7d,
    sales30d,
    inactive7d,
    inactive14d,
    inactive30d,
    trend,
  ] = await Promise.all([
    db.execute(activeTodayTzSql) as unknown as Promise<CountRow[]>,
    db.execute(activeSql("7 days")) as unknown as Promise<CountRow[]>,
    db.execute(activeSql("30 days")) as unknown as Promise<CountRow[]>,
    db.execute(salesTodayTzSql) as unknown as Promise<CountRow[]>,
    db.execute(salesSql("7 days")) as unknown as Promise<CountRow[]>,
    db.execute(salesSql("30 days")) as unknown as Promise<CountRow[]>,
    db.execute(inactiveSql("7 days")) as unknown as Promise<CountRow[]>,
    db.execute(inactiveSql("14 days")) as unknown as Promise<CountRow[]>,
    db.execute(inactiveSql("30 days")) as unknown as Promise<CountRow[]>,
    db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}) - INTERVAL '29 days',
          date_trunc('day', ${nowIso}::timestamptz AT TIME ZONE ${tz}),
          INTERVAL '1 day'
        ) AS day_bucket
      ),
      buckets AS (
        SELECT date_trunc('day', created_at AT TIME ZONE ${tz}) AS day_bucket,
               COUNT(DISTINCT tenant_id) AS c
        FROM activity_logs
        WHERE created_at > ${nowIso}::timestamptz - INTERVAL '30 days'
        GROUP BY 1
      )
      SELECT to_char(days.day_bucket, 'YYYY-MM-DD') AS day,
             COALESCE(buckets.c, 0)::int AS c
      FROM days
      LEFT JOIN buckets ON buckets.day_bucket = days.day_bucket
      ORDER BY days.day_bucket ASC
    `) as unknown as Promise<DayRow[]>,
  ]);

  return {
    activeToday: num(pickRows<CountRow>(activeToday)[0]?.c),
    active7d: num(pickRows<CountRow>(active7d)[0]?.c),
    active30d: num(pickRows<CountRow>(active30d)[0]?.c),
    salesActiveToday: num(pickRows<CountRow>(salesToday)[0]?.c),
    salesActive7d: num(pickRows<CountRow>(sales7d)[0]?.c),
    salesActive30d: num(pickRows<CountRow>(sales30d)[0]?.c),
    inactive7d: num(pickRows<CountRow>(inactive7d)[0]?.c),
    inactive14d: num(pickRows<CountRow>(inactive14d)[0]?.c),
    inactive30d: num(pickRows<CountRow>(inactive30d)[0]?.c),
    activityTrend30d: pickRows<DayRow>(trend).map((r) => ({
      day: r.day,
      stores: num(r.c),
    })),
  };
}

// ─── Per-tenant presence detail ─────────────────────────────────────────────

export async function getTenantPresence(
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantPresenceDetail> {
  const db = getAdminDb();
  const nowIso = now.toISOString();

  type CountRow = { c: number | string };
  type PlatformRow = { platform: string; c: number | string };
  type HourRow = { hour: string; c: number | string };

  const [onlineNow, activeToday, activeDevices, platMobile, platWeb, last24] =
    await Promise.all([
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS c FROM (
          SELECT user_id FROM auth_devices
            WHERE tenant_id = ${tenantId}
              AND revoked_at IS NULL
              AND last_used_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
          UNION ALL
          SELECT user_id FROM web_live_sessions
            WHERE tenant_id = ${tenantId}
              AND last_activity_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
        ) u
      `) as unknown as Promise<CountRow[]>,
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS c FROM (
          SELECT user_id FROM auth_devices
            WHERE tenant_id = ${tenantId}
              AND revoked_at IS NULL
              AND last_used_at > ${nowIso}::timestamptz - INTERVAL '24 hours'
          UNION ALL
          SELECT user_id FROM web_live_sessions
            WHERE tenant_id = ${tenantId}
              AND last_activity_at > ${nowIso}::timestamptz - INTERVAL '24 hours'
          UNION ALL
          SELECT actor_user_id FROM activity_logs
            WHERE tenant_id = ${tenantId}
              AND actor_user_id IS NOT NULL
              AND created_at > ${nowIso}::timestamptz - INTERVAL '24 hours'
        ) u
      `) as unknown as Promise<CountRow[]>,
      db.execute(sql`
        SELECT COUNT(*)::int AS c FROM auth_devices
        WHERE tenant_id = ${tenantId}
          AND revoked_at IS NULL
          AND last_used_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
      `) as unknown as Promise<CountRow[]>,
      db.execute(sql`
        SELECT COALESCE(platform, 'other') AS platform, COUNT(DISTINCT user_id)::int AS c
        FROM auth_devices
        WHERE tenant_id = ${tenantId}
          AND revoked_at IS NULL
          AND last_used_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
        GROUP BY COALESCE(platform, 'other')
      `) as unknown as Promise<PlatformRow[]>,
      db.execute(sql`
        SELECT platform, COUNT(DISTINCT user_id)::int AS c
        FROM web_live_sessions
        WHERE tenant_id = ${tenantId}
          AND last_activity_at > ${nowIso}::timestamptz - make_interval(secs => ${onlineSeconds})
        GROUP BY platform
      `) as unknown as Promise<PlatformRow[]>,
      db.execute(sql`
        WITH hours AS (
          SELECT generate_series(
            date_trunc('hour', ${nowIso}::timestamptz) - INTERVAL '23 hours',
            date_trunc('hour', ${nowIso}::timestamptz),
            INTERVAL '1 hour'
          ) AS hour_bucket
        ),
        activity_buckets AS (
          SELECT date_trunc('hour', created_at) AS hour_bucket,
                 COUNT(DISTINCT actor_user_id) AS c
          FROM activity_logs
          WHERE tenant_id = ${tenantId}
            AND actor_user_id IS NOT NULL
            AND created_at > ${nowIso}::timestamptz - INTERVAL '24 hours'
          GROUP BY 1
        )
        SELECT to_char(hours.hour_bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24":00:00Z"') AS hour,
               COALESCE(activity_buckets.c, 0)::int AS c
        FROM hours
        LEFT JOIN activity_buckets ON activity_buckets.hour_bucket = hours.hour_bucket
        ORDER BY hours.hour_bucket ASC
      `) as unknown as Promise<HourRow[]>,
    ]);

  const platformMap = { ios: 0, android: 0, web: 0, other: 0 };
  for (const r of pickRows<PlatformRow>(platMobile)) {
    const p = r.platform;
    if (p === "ios" || p === "android" || p === "web") platformMap[p] += num(r.c);
    else platformMap.other += num(r.c);
  }
  for (const r of pickRows<PlatformRow>(platWeb)) {
    const p = r.platform;
    if (p === "web") platformMap.web += num(r.c);
    else platformMap.other += num(r.c);
  }

  return {
    onlineNow: num(pickRows<CountRow>(onlineNow)[0]?.c),
    activeToday: num(pickRows<CountRow>(activeToday)[0]?.c),
    activeDevices: num(pickRows<CountRow>(activeDevices)[0]?.c),
    byPlatform: platformMap,
    activityLast24h: pickRows<HourRow>(last24).map((r) => ({
      hour: r.hour,
      users: num(r.c),
    })),
  };
}

// ─── Last-active per tenant (for the admin list column) ─────────────────────

/**
 * Exact MAX(last activity) per tenant for the given set of tenant ids.
 * Combines both heartbeat sources + activity_logs. One query.
 */
export async function lastActivityByTenant(
  tenantIds: string[],
): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>();
  if (tenantIds.length === 0) return out;
  const db = getAdminDb();
  type Row = { tenant_id: string; last_at: string | null };

  const rows = (await db.execute(sql`
    SELECT tenant_id::text AS tenant_id, MAX(last_at) AS last_at FROM (
      SELECT tenant_id, MAX(last_used_at) AS last_at FROM auth_devices
        WHERE tenant_id = ANY(${sql.raw(
          `ARRAY[${tenantIds.map((id) => `'${id}'::uuid`).join(",")}]`,
        )})
          AND revoked_at IS NULL
        GROUP BY tenant_id
      UNION ALL
      SELECT tenant_id, MAX(last_activity_at) AS last_at FROM web_live_sessions
        WHERE tenant_id = ANY(${sql.raw(
          `ARRAY[${tenantIds.map((id) => `'${id}'::uuid`).join(",")}]`,
        )})
        GROUP BY tenant_id
      UNION ALL
      SELECT tenant_id, MAX(created_at) AS last_at FROM activity_logs
        WHERE tenant_id = ANY(${sql.raw(
          `ARRAY[${tenantIds.map((id) => `'${id}'::uuid`).join(",")}]`,
        )})
        GROUP BY tenant_id
    ) u
    GROUP BY tenant_id
  `)) as unknown as Row[];

  for (const r of pickRows<Row>(rows)) {
    out.set(
      r.tenant_id,
      r.last_at ? new Date(r.last_at) : null,
    );
  }
  for (const id of tenantIds) if (!out.has(id)) out.set(id, null);
  return out;
}
