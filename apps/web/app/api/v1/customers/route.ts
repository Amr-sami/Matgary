import { NextRequest, NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/permissions";
import { normalizeEgyptPhoneAny } from "@/lib/validators/egypt";
import {
  LAST_PURCHASE_AT_TO_CHAR,
  decodeCustomerCursor,
  encodeCustomerCursor,
} from "@/lib/repo/customer-cursor";

// GET /api/v1/customers — the customer list, aggregated on the server.
//
// The web page (app/customers/page.tsx) gets here by calling `useCustomersData`,
// which pulls the tenant's ENTIRE non-windowed sales history over the wire and
// runs `buildCustomerAggregatesGeneric` in the browser. That is affordable on a
// desktop with the whole history already in a TanStack cache; on a phone over
// Egyptian 3G it means megabytes of sale lines to render one screen of names.
// So the same rollup runs in Postgres here, and the wire carries one row per
// customer instead of one row per sale line.
//
// The aggregation below is a faithful port of `buildCustomerAggregatesGeneric`
// with one deliberate narrowing: it groups by phone ONLY. The web helper falls
// back to a `name:<lowercased>` key for walk-ins who gave a name but no number.
// A native client cannot act on those rows — every follow-up affordance
// (ledger lookup at /customers/by-phone/:phone, WhatsApp, settle) is keyed on
// the phone — and a name-keyed group has no stable cursor key either, since the
// name is mutable per sale row. They are excluded rather than returned as
// dead entries.
//
// No repo function covers this: lib/repo/customers.ts is the per-phone ledger
// (one customer, every invoice), not a paginated roll-up across customers.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Shortest digit run we will run a partial-phone scan for. Below three
 *  digits every customer matches, which is a full table read for nothing. */
const MIN_PHONE_FRAGMENT = 3;

const querySchema = z.object({
  cursor: z.string().min(1).max(200).nullable(),
  // Coerced, not clamped, by zod: a non-numeric `limit` is a client bug and
  // gets its own machine code, while an out-of-range number is clamped below
  // (silently serving 200 beats failing a screen over an over-eager prefetch).
  limit: z.coerce.number().int().positive().nullable(),
  q: z.string().max(120).nullable(),
});

// The cursor codec lives in lib/repo/customer-cursor.ts: it carries the
// timestamp as Postgres text (microseconds intact), never as a Date, and the
// unit test there is what proves a page boundary cannot skip a customer.

/** Escape the LIKE metacharacters so a customer searching for "50%" does not
 *  get a wildcard. Backslash is Postgres' default LIKE escape character. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII.
 *
 * `normalizeEgyptPhoneAny` already does this internally, but only for a
 * COMPLETE number — and it exports no standalone helper. The partial-fragment
 * branch below needs the same treatment or an owner typing "٠١٠٠١٢٣" on an
 * Arabic keypad searches for an empty string and matches nothing. Covers
 * exactly the two code-point ranges that file's ARABIC_DIGITS map covers.
 */
function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const cp = ch.codePointAt(0)!;
    return String(cp - (cp <= 0x0669 ? 0x0660 : 0x06f0));
  });
}

/**
 * Build the `?q=` predicate, or null when there is nothing to filter on.
 *
 * It lands in HAVING rather than WHERE on purpose. A name match has to be
 * evaluated per GROUP: the name lives on each sale row and the customer may
 * have given it on only some of them, so filtering rows in WHERE would drop
 * the other rows from that customer's totals and report a spend figure lower
 * than the ledger page shows. `customer_phone` is the grouping key, so it is
 * legal to reference bare in HAVING alongside the aggregate.
 */
function buildSearchFilter(raw: string): SQL | null {
  const q = raw.trim();
  if (!q) return null;

  const clauses: SQL[] = [];

  // Phone side. The normaliser collapses "01001234009", "1001234009" and
  // "+201001234009" to one canonical form; we then match on its 10-digit
  // national part as a SUFFIX, against the stored number stripped of every
  // non-digit. That makes the search independent of the shape any given
  // legacy row happens to be stored in.
  const canonical = normalizeEgyptPhoneAny(q);
  const digitsOnly = sql`regexp_replace(customer_phone, '[^0-9]', '', 'g')`;
  if (canonical) {
    const national = canonical.slice(3); // drop the "+20"
    clauses.push(sql`${digitsOnly} LIKE ${`%${national}`}`);
  } else {
    // Not a complete number — treat it as a fragment the owner is typing.
    // Both the as-typed digits and the leading-0 / leading-20 stripped forms
    // are tried, so "0100123" still finds a row stored as "1001234009".
    const typed = asciiDigits(q).replace(/[^0-9]/g, "");
    const fragments = new Set(
      [typed, typed.replace(/^0+/, ""), typed.replace(/^20/, "")].filter(
        (f) => f.length >= MIN_PHONE_FRAGMENT,
      ),
    );
    for (const f of fragments) {
      clauses.push(sql`${digitsOnly} LIKE ${`%${f}%`}`);
    }
  }

  // Name side. ILIKE is the same case-insensitive contains the web page does
  // with `.toLowerCase().includes()`; Arabic is caseless so this is a plain
  // substring match there. bool_or lifts the per-row test to the group.
  clauses.push(
    sql`bool_or(COALESCE(customer_name, '') ILIKE ${`%${escapeLike(q)}%`})`,
  );

  return sql`(${sql.join(clauses, sql` OR `)})`;
}

interface CustomerRow {
  phone: string;
  name: string | null;
  total_spend: string;
  invoice_count: number;
  // postgres-js hands raw `execute()` results back un-parsed, so a timestamptz
  // arrives as the text Postgres sent ("2026-09-16 14:05:54.947665+00"), NOT
  // as a Date — unlike a typed drizzle select, which applies the column mapper.
  // Widened to match reality and funnelled through toDate() below; assuming a
  // Date here is what made every request to this route throw.
  last_purchase_at: Date | string;
  /** to_char() output, LAST_PURCHASE_AT_TO_CHAR shape: "2026-09-16T14:05:54.947665Z". */
  last_purchase_at_iso: string;
  outstanding: string;
  oldest_unpaid_at: Date | string | null;
}

/** See CustomerRow.last_purchase_at. Tolerates both shapes so the route keeps
 *  working if the driver's parsing behaviour ever changes underneath it. */
function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

export async function GET(req: NextRequest) {
  // Branch-scoped like the rest of the app. Note this is not merely a filter:
  // the multi-store model treats a customer's debt as per-branch (see the
  // header comment on lib/repo/customers.ts), so an "all branches" roll-up
  // would report an outstanding figure that no settlement screen can act on.
  // The active branch comes from X-Branch-Id for native callers.
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;

  if (!can(r.ctx, "view_customers")) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;

  const params = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    cursor: params.get("cursor"),
    limit: params.get("limit"),
    q: params.get("q"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400 });
  }

  const limit = Math.min(MAX_LIMIT, parsed.data.limit ?? DEFAULT_LIMIT);

  // A cursor we cannot parse is rejected instead of being ignored: silently
  // restarting at page 1 would hand a paging client the first page forever.
  const rawCursor = parsed.data.cursor;
  const cursor = decodeCustomerCursor(rawCursor);
  if (rawCursor && !cursor) {
    return NextResponse.json({ error: "INVALID_CURSOR" }, { status: 400 });
  }

  const searchFilter = parsed.data.q ? buildSearchFilter(parsed.data.q) : null;

  // Rows that can never produce an addressable customer. `is_returned` mirrors
  // the web helper, which skips returned lines before it accumulates anything.
  const baseWhere = sql`
    WHERE tenant_id      = ${r.ctx.tenantId}
      AND branch_id      = ${r.ctx.branchId}
      AND is_returned    = false
      AND customer_phone IS NOT NULL
      AND btrim(customer_phone) <> ''
  `;

  const havingParts: SQL[] = [];
  if (searchFilter) havingParts.push(searchFilter);
  if (cursor) {
    // Keyset, not OFFSET. The sort is (lastPurchaseAt DESC, phone DESC) and
    // the cursor carries that exact tuple, so the row-comparison below resumes
    // at the precise point the previous page stopped — a sale recorded between
    // two page fetches cannot shift a customer across the boundary and make
    // them appear twice or vanish, which is what OFFSET would do. The phone
    // tiebreak matters: several customers can share a lastPurchaseAt to the
    // microsecond when one cart was rung up for a group, and a date-only
    // cursor would skip all but one of them.
    //
    // `lastPurchaseAt` is the text Postgres itself rendered for the previous
    // page's last row (see the SELECT below), cast straight back. It is NOT
    // passed through a Date: that would round to the millisecond, and a
    // customer whose MAX(sale_date) shares the boundary row's millisecond
    // but not its microseconds would compare as not-below and be skipped.
    havingParts.push(
      sql`(MAX(sale_date), customer_phone) < (${cursor.lastPurchaseAt}::timestamptz, ${cursor.phone})`,
    );
  }
  const having =
    havingParts.length > 0
      ? sql`HAVING ${sql.join(havingParts, sql` AND `)}`
      : sql``;

  const result = await withTenant(r.ctx.tenantId, async (tx) => {
    // limit + 1 so "is there a next page" costs no extra query.
    const rows = (await tx.execute(sql`
      SELECT
        customer_phone AS phone,
        (array_agg(customer_name ORDER BY sale_date DESC, id DESC)
           FILTER (WHERE customer_name IS NOT NULL
                     AND btrim(customer_name) <> ''))[1] AS name,
        SUM(CAST(total_price AS numeric(14,2)))::text AS total_spend,
        COUNT(DISTINCT COALESCE(invoice_id, id::text))::int AS invoice_count,
        MAX(sale_date) AS last_purchase_at,
        -- The same instant as text at full precision, for the cursor only.
        -- The driver turns the column above into a JS Date (milliseconds);
        -- this one never touches a Date and so round-trips exactly.
        to_char(MAX(sale_date) AT TIME ZONE 'UTC', ${LAST_PURCHASE_AT_TO_CHAR})
          AS last_purchase_at_iso,
        COALESCE(
          SUM(GREATEST(CAST(total_price AS numeric(14,2)) - amount_paid, 0)),
          0
        )::text AS outstanding,
        MIN(sale_date) FILTER (
          WHERE CAST(total_price AS numeric(14,2)) - amount_paid > 0
        ) AS oldest_unpaid_at
      FROM sales
      ${baseWhere}
      GROUP BY customer_phone
      ${having}
      ORDER BY MAX(sale_date) DESC, customer_phone DESC
      LIMIT ${limit + 1}
    `)) as unknown as CustomerRow[];

    // `total` is the count of DISTINCT customers, which means a second pass
    // over the branch's sales. It is computed on the first page only — the
    // client needs it once to render "N عميل" and paging cannot change it
    // materially, so continuation pages return null rather than paying for
    // the same scan on every scroll over 3G.
    let total: number | null = null;
    if (!cursor) {
      const [row] = (await tx.execute(sql`
        SELECT COUNT(*)::int AS total
          FROM (
            SELECT customer_phone
              FROM sales
              ${baseWhere}
             GROUP BY customer_phone
             ${searchFilter ? sql`HAVING ${searchFilter}` : sql``}
          ) grouped
      `)) as unknown as Array<{ total: number }>;
      total = row?.total ?? 0;
    }

    return { rows, total };
  });

  const hasMore = result.rows.length > limit;
  const page = hasMore ? result.rows.slice(0, limit) : result.rows;
  const last = page[page.length - 1];

  return NextResponse.json({
    data: page.map((row) => ({
      phone: row.phone,
      // Most recent non-empty name wins. Customers get re-entered with a
      // typo or a fuller name on a later visit and the newest spelling is
      // the one the owner just typed, so it is the one they expect to see.
      name: row.name,
      totalSpend: Number(row.total_spend),
      invoiceCount: row.invoice_count,
      lastPurchaseAt: toDate(row.last_purchase_at).toISOString(),
      outstanding: Number(row.outstanding),
      // Non-null only when something is still owed. Receivables aging is the
      // reason an owner opens this list, and it saves the client a per-row
      // ledger fetch to compute "unpaid for N days".
      oldestUnpaidAt: row.oldest_unpaid_at
        ? toDate(row.oldest_unpaid_at).toISOString()
        : null,
    })),
    nextCursor:
      hasMore && last
        ? encodeCustomerCursor({
            lastPurchaseAt: last.last_purchase_at_iso,
            phone: last.phone,
          })
        : null,
    total: result.total,
    branchId: r.ctx.branchId,
    branchName: r.ctx.branchName,
  });
}
