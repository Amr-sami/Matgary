import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  branches,
  digestSettings,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { guardCronRequest } from "@/lib/cron/auth";
import { computeDigest, isDigestEmpty } from "@/lib/repo/digest";
import {
  insertDigestRun,
  markRunFailed,
  markRunSent,
} from "@/lib/repo/digest-runs";
import { renderDigestMessage } from "@/lib/digest/render";
import { sendTextToMeta } from "@/lib/whatsapp/outbound-sender";
import { normalizePhone } from "@/lib/settings";
import { logActivity } from "@/lib/repo/activity";

// Hourly (or 30-min) tick. For every tenant where digest_settings.enabled
// AND it's currently `digest_hour:NN` in their local tz, build + send the
// branch-scoped digest to every configured recipient. Idempotency lives
// in the digest_runs unique index so a double-tick is a no-op.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Recipient {
  userId: string | null;
  phone: string | null;
  email: string | null;
  locale: "ar" | "en";
}

export async function POST(req: NextRequest) {
  const blocked = await guardCronRequest(req, { bucket: "cron.digest_tick" });
  if (blocked) return blocked;

  const dashboardBase = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  // Spec 03: skip suspended tenants — no digest goes out while paused.
  const tenantRows = await db
    .select({ id: tenants.id, slug: tenants.slug, tz: tenants.timezone })
    .from(tenants)
    .where(sql`${tenants.suspendedAt} IS NULL`);

  let enqueued = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const t of tenantRows) {
    try {
      // Load digest settings.
      const [setting] = await db
        .select()
        .from(digestSettings)
        .where(eq(digestSettings.tenantId, t.id))
        .limit(1);
      if (!setting || !setting.enabled) continue;

      // Compute local hour. We use Postgres to convert UTC now() to the
      // tenant's tz, then read the integer hour. Stays correct across DST
      // and weird tzdb cases without us importing date-fns-tz.
      const localHourRows = (await db.execute(sql`
        select extract(hour from (now() at time zone ${t.tz}))::int as hour,
               (now() at time zone ${t.tz})::date::text as business_date
      `)) as unknown as
        | { hour: number; business_date: string }[]
        | { rows: { hour: number; business_date: string }[] };
      const local = Array.isArray(localHourRows)
        ? localHourRows[0]
        : localHourRows?.rows?.[0];
      if (!local) continue;
      if (local.hour !== setting.digestHour) continue;
      const businessDate = local.business_date;

      // Active branches for this tenant.
      const branchRows = await db
        .select({ id: branches.id, name: branches.name })
        .from(branches)
        .where(and(eq(branches.tenantId, t.id), eq(branches.isActive, true)));

      // Build recipient list. Owners get every branch; managers only their
      // subscribed branch; extras come straight off the settings row.
      const members = await db
        .select({
          userId: tenantMembers.userId,
          role: tenantMembers.role,
          branchId: tenantMembers.branchId,
          phone: tenantMembers.phone,
        })
        .from(tenantMembers)
        .where(eq(tenantMembers.tenantId, t.id));

      const userIds = members.map((m) => m.userId);
      // Phone comes from tenant_members (per-tenant contact), email + locale
      // from users (account-wide).
      const phoneByMember = new Map(members.map((m) => [m.userId, m.phone ?? null]));
      const userRows =
        userIds.length === 0
          ? []
          : await db
              .select({
                id: users.id,
                email: users.email,
                locale: users.locale,
              })
              .from(users)
              .where(
                sql`${users.id} = any(${sql.raw(
                  `array[${userIds.map((id) => `'${id}'`).join(",")}]::uuid[]`,
                )})`,
              );
      const userById = new Map(userRows.map((u) => [u.id, u]));

      for (const branch of branchRows) {
        const recipients: Recipient[] = [];
        // 1. The owner_phone set in digest settings — explicit primary
        // recipient, intentionally separate from receipt-sending creds.
        // We tag it userId=null so the phone-only idempotency unique
        // index covers it across multiple owners on the same tenant.
        if (setting.ownerPhone) {
          recipients.push({
            userId: null,
            phone: setting.ownerPhone,
            email: null,
            // Settings UI is owner-only; locale falls back to the
            // tenant's default (ar). EN users can switch via the user
            // menu and that flips users.locale, but for the explicit
            // phone path we don't have a user record.
            locale: "ar",
          });
        } else {
          // Fallback: any owner-role member with a phone on tenant_members.
          for (const m of members.filter((m) => m.role === "owner")) {
            const u = userById.get(m.userId);
            if (!u) continue;
            recipients.push({
              userId: u.id,
              phone: phoneByMember.get(u.id) ?? null,
              email: u.email ?? null,
              locale: (u.locale as "ar" | "en" | null) ?? "ar",
            });
          }
        }
        // Subscribed managers → only their branch.
        for (const m of members.filter(
          (m) =>
            m.role !== "owner" &&
            setting.managersSubscribed.includes(m.userId) &&
            m.branchId === branch.id,
        )) {
          const u = userById.get(m.userId);
          if (!u) continue;
          recipients.push({
            userId: u.id,
            phone: phoneByMember.get(u.id) ?? null,
            email: u.email ?? null,
            locale: (u.locale as "ar" | "en" | null) ?? "ar",
          });
        }
        // Extras.
        for (const extra of setting.extraRecipients ?? []) {
          recipients.push({
            userId: null,
            phone: extra.phone ?? null,
            email: extra.email ?? null,
            locale: (extra.locale as "ar" | "en" | null) ?? "ar",
          });
        }

        if (recipients.length === 0) continue;

        // Compute payload once per branch.
        const payload = await computeDigest(t.id, branch.id, businessDate);

        if (!setting.sendOnEmpty && isDigestEmpty(payload)) {
          // Record a single 'skipped_empty' row so /settings/digest history
          // shows the tick ran but produced no message.
          await insertDigestRun({
            tenantId: t.id,
            branchId: branch.id,
            businessDate,
            channel: "whatsapp",
            recipientUserId: recipients[0]?.userId ?? null,
            recipientPhone: recipients[0]?.phone ?? null,
            recipientEmail: recipients[0]?.email ?? null,
            payload,
            messageText: null,
            status: "skipped_empty",
          });
          skipped += 1;
          continue;
        }

        // Send per recipient.
        for (const r of recipients) {
          const dashboardUrl = `${dashboardBase}/?branch=${branch.id}`;
          const messageText = renderDigestMessage(payload, {
            locale: r.locale,
            dashboardUrl,
          });

          const insertResult = await insertDigestRun({
            tenantId: t.id,
            branchId: branch.id,
            businessDate,
            recipientUserId: r.userId,
            recipientPhone: r.phone,
            recipientEmail: r.email,
            channel: "whatsapp",
            payload,
            messageText,
            status: r.phone ? "pending" : "skipped_no_channel",
          });
          // Null → already inserted by a previous tick. Skip.
          if (!insertResult) {
            skipped += 1;
            continue;
          }
          enqueued += 1;

          if (!r.phone) {
            // No WhatsApp possible. Email fallback is v1.1 — skip for now.
            continue;
          }
          const normalised = normalizePhone(r.phone);
          if (!normalised) {
            await markRunFailed(t.id, insertResult.id, "invalid_phone");
            failed += 1;
            continue;
          }
          try {
            const outcome = await sendTextToMeta({
              tenantId: t.id,
              branchId: branch.id,
              phoneE164NoPlus: normalised.replace(/^\+/, ""),
              message: messageText,
            });
            if (outcome.ok) {
              await markRunSent(t.id, insertResult.id, outcome.metaMessageId ?? null);
              sent += 1;
            } else {
              await markRunFailed(
                t.id,
                insertResult.id,
                outcome.errorMessage ?? `status ${outcome.status}`,
              );
              failed += 1;
            }
          } catch (e) {
            await markRunFailed(
              t.id,
              insertResult.id,
              e instanceof Error ? e.message : String(e),
            );
            failed += 1;
          }
        }
      }

      if (enqueued > 0 || sent > 0) {
        logActivity({
          tenantId: t.id,
          actorUserId: null,
          actorName: "نظام (جدولة)",
          action: "digest.tick",
          category: "settings",
          metadata: { enqueued, sent, skipped, failed },
        });
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[cron/digest-tick] tenant ${t.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    tenants: tenantRows.length,
    enqueued,
    sent,
    skipped,
    failed,
  });
}
