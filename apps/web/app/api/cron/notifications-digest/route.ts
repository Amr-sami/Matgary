import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import {
  notificationDigestQueue,
  tenants,
  users,
} from "@/lib/db/schema";
import { rateLimit } from "@/lib/ratelimit";
import { sendMail } from "@/lib/mailer";
import { logger } from "@/lib/logger";
import {
  renderInApp,
  type EventPayloadMap,
} from "@/lib/notifications/dispatch";
import { isNotificationEventType } from "@/lib/notifications/event-types";
import { clientIp } from "@/lib/request-ip";

// Daily digest cron. Drains `notification_digest_queue` — every row is a
// buffered event a user opted to receive as an end-of-day summary instead of
// an instant email. We group by (tenant, user), render one combined email
// per user in their preferred locale, send it, and stamp `sent_at` so the
// row is skipped next run.
//
// Same auth model as the other cron routes here (bearer + timingSafeEqual +
// per-IP rate limit + POST only).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 6;
const RATE_WINDOW_SEC = 60 * 60;
// Cap the batch so a backlog doesn't blow the request timeout — the cron
// re-runs shortly enough that draining across two ticks is fine.
const MAX_ROWS_PER_RUN = 5000;

function bearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim();
}

function checkSecret(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limit = await rateLimit("cron.notifications_digest", ip, {
    limit: RATE_LIMIT,
    windowSec: RATE_WINDOW_SEC,
  });
  if (!limit.ok) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  if (!checkSecret(bearerToken(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tenantRows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants);

  let emailsSent = 0;
  let rowsMarked = 0;
  let failures = 0;

  for (const t of tenantRows) {
    try {
      const perTenant = await drainTenant(t.id, t.name ?? "");
      emailsSent += perTenant.emailsSent;
      rowsMarked += perTenant.rowsMarked;
    } catch (err) {
      failures += 1;
      logger.error({
        event: "notif.digest_tenant_failed",
        tenantId: t.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    tenants: tenantRows.length,
    emailsSent,
    rowsMarked,
    failures,
  });
}

interface QueueRow {
  id: string;
  userId: string;
  eventType: string;
  payload: unknown;
}

interface UserBucket {
  userId: string;
  email: string;
  locale: "ar" | "en";
  rows: QueueRow[];
}

async function drainTenant(
  tenantId: string,
  tenantName: string,
): Promise<{ emailsSent: number; rowsMarked: number }> {
  // 1) Pull unsent rows for the tenant along with recipient details.
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        id: notificationDigestQueue.id,
        userId: notificationDigestQueue.userId,
        eventType: notificationDigestQueue.eventType,
        payload: notificationDigestQueue.payload,
        email: users.email,
        locale: users.locale,
      })
      .from(notificationDigestQueue)
      .innerJoin(users, eq(users.id, notificationDigestQueue.userId))
      .where(
        and(
          eq(notificationDigestQueue.tenantId, tenantId),
          isNull(notificationDigestQueue.sentAt),
        ),
      )
      .orderBy(asc(notificationDigestQueue.createdAt))
      .limit(MAX_ROWS_PER_RUN),
  );

  if (rows.length === 0) return { emailsSent: 0, rowsMarked: 0 };

  // 2) Bucket by user so each user gets exactly one email per run.
  const buckets = new Map<string, UserBucket>();
  for (const r of rows) {
    if (!r.email) continue;
    const key = r.userId;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        userId: r.userId,
        email: r.email,
        locale: r.locale === "en" ? "en" : "ar",
        rows: [],
      };
      buckets.set(key, bucket);
    }
    bucket.rows.push({
      id: r.id,
      userId: r.userId,
      eventType: r.eventType,
      payload: r.payload,
    });
  }

  // 3) Send + mark. We mark rows as sent AFTER a successful email send so a
  //    transient SMTP hiccup leaves them queued for the next run instead of
  //    silently dropping. Rows for users with no email get marked sent (the
  //    email would never go anywhere; keeping them queued forever is worse).
  let emailsSent = 0;
  let rowsMarked = 0;

  for (const bucket of buckets.values()) {
    const { subject, text } = renderDigest(bucket, tenantName);
    const send = await sendMail({ to: bucket.email, subject, text });
    if (send.delivered || send.reason === "no_smtp_configured") {
      const ids = bucket.rows.map((r) => r.id);
      await withTenant(tenantId, async (tx) =>
        tx.execute(sql`
          UPDATE notification_digest_queue
             SET sent_at = now()
           WHERE tenant_id = ${tenantId}
             AND id IN (${sql.join(
               ids.map((id) => sql`${id}`),
               sql`, `,
             )})
        `),
      );
      rowsMarked += ids.length;
      if (send.delivered) emailsSent += 1;
    }
  }

  // Also mark rows for users with no email (would never be delivered).
  const noEmailIds = rows
    .filter((r) => !r.email)
    .map((r) => r.id);
  if (noEmailIds.length > 0) {
    await withTenant(tenantId, async (tx) =>
      tx.execute(sql`
        UPDATE notification_digest_queue
           SET sent_at = now()
         WHERE tenant_id = ${tenantId}
           AND id IN (${sql.join(
             noEmailIds.map((id) => sql`${id}`),
             sql`, `,
           )})
      `),
    );
    rowsMarked += noEmailIds.length;
  }

  return { emailsSent, rowsMarked };
}

function renderDigest(
  bucket: UserBucket,
  tenantName: string,
): { subject: string; text: string } {
  const ar = bucket.locale === "ar";
  const store = tenantName ? ` — ${tenantName}` : "";

  // Group rows by event type so the summary reads "5 sales, 2 low-stock..."
  const byType = new Map<string, QueueRow[]>();
  for (const r of bucket.rows) {
    const list = byType.get(r.eventType) ?? [];
    list.push(r);
    byType.set(r.eventType, list);
  }

  const sections: string[] = [];
  for (const [eventType, list] of byType) {
    if (!isNotificationEventType(eventType)) continue;
    sections.push(ar ? `— ${labelAr(eventType)} (${list.length})` : `— ${labelEn(eventType)} (${list.length})`);
    for (const r of list) {
      const rendered = renderInApp(
        eventType,
        r.payload as EventPayloadMap[typeof eventType],
        bucket.locale,
      );
      sections.push(`  · ${rendered.title}${rendered.body ? ` — ${rendered.body}` : ""}`);
    }
    sections.push("");
  }

  const subject = ar
    ? `ملخص اليوم — ${bucket.rows.length} حدث${store}`
    : `Daily digest — ${bucket.rows.length} events${store}`;
  const header = ar
    ? "إليك ملخّص أحداث متجرك اليوم:\n"
    : "Here is today's summary of store activity:\n";
  const footer = ar
    ? `\nستورو${tenantName ? ` — ${tenantName}` : ""}`
    : `\nTheStoro${tenantName ? ` — ${tenantName}` : ""}`;
  return {
    subject,
    text: `${header}\n${sections.join("\n")}${footer}`,
  };
}

function labelAr(eventType: string): string {
  switch (eventType) {
    case "sale.created":
      return "المبيعات";
    case "purchase.received":
      return "التوريدات المستلمة";
    case "inventory.low_stock":
      return "تنبيهات مخزون منخفض";
    case "payment.deferred_settled":
      return "مدفوعات آجل مسدّدة";
    case "leave.requested":
      return "طلبات إجازة";
    default:
      return eventType;
  }
}

function labelEn(eventType: string): string {
  switch (eventType) {
    case "sale.created":
      return "Sales";
    case "purchase.received":
      return "Purchases received";
    case "inventory.low_stock":
      return "Low stock alerts";
    case "payment.deferred_settled":
      return "Deferred settlements";
    case "leave.requested":
      return "Leave requests";
    default:
      return eventType;
  }
}
