// Keyset cursor for GET /api/v1/customers.
//
// The list is sorted (MAX(sale_date) DESC, customer_phone DESC) and paged
// with a row-value comparison on that exact tuple. The cursor therefore has
// to carry the timestamp at the precision Postgres compares it at —
// microseconds. It used to go through a JS Date, which is millisecond-only:
// a boundary row stored at 10:00:00.123456 became 10:00:00.123 in the cursor,
// and every customer whose last purchase fell in the truncated 456µs — same
// millisecond, smaller microseconds — compared as NOT below the cursor and
// silently vanished from page 2. Postgres writes microsecond timestamps
// whenever sale_date comes from now() rather than a JS Date, so this was a
// real skip, not a theoretical one.
//
// Fix: the route asks Postgres to render MAX(sale_date) as ISO-8601 text with
// six fractional digits (LAST_PURCHASE_AT_TO_CHAR) and the cursor carries
// that text verbatim; on the way back in it is cast with ::timestamptz, which
// round-trips exactly. No Date object is ever on the path.
//
// Pure module so the codec and the ordering contract are unit-testable
// without a database (tests/unit/customer-cursor.test.ts).

export interface CustomerCursor {
  /** ISO-8601 UTC text, e.g. "2026-09-18T10:00:00.123456Z". Never a Date. */
  lastPurchaseAt: string;
  /** Canonical +20… phone — the tiebreak, and the group key. */
  phone: string;
}

/** The to_char() pattern the route uses to render MAX(sale_date). `US` is
 *  microseconds, always six digits, so the text sorts the way the timestamp
 *  does. Apply to a UTC-shifted value: `to_char(x AT TIME ZONE 'UTC', …)`. */
export const LAST_PURCHASE_AT_TO_CHAR = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** What we accept back: the format above, or the 3-digit variant a cursor
 *  minted before this module existed carries. Anything else is rejected —
 *  the text goes straight into a ::timestamptz cast. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/**
 * Cursors are base64url. The payload is `<iso>|<phone>` and phones are stored
 * canonically as `+201…` — a bare `+` in a query string decodes to a space, so
 * an unencoded cursor would silently corrupt itself on the way back to us.
 */
export function encodeCustomerCursor(c: CustomerCursor): string {
  return Buffer.from(`${c.lastPurchaseAt}|${c.phone}`, "utf8").toString(
    "base64url",
  );
}

export function decodeCustomerCursor(
  raw: string | null | undefined,
): CustomerCursor | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const i = decoded.indexOf("|");
  if (i < 0) return null;
  const lastPurchaseAt = decoded.slice(0, i);
  const phone = decoded.slice(i + 1);
  if (!ISO_UTC_RE.test(lastPurchaseAt)) return null;
  if (Number.isNaN(Date.parse(lastPurchaseAt))) return null;
  if (!phone) return null;
  return { lastPurchaseAt, phone };
}

/** Pad the fractional part to six digits so two renderings of the same
 *  instant ("….123Z" from an old cursor, "….123000Z" from Postgres) compare
 *  equal as text. Lexical order on this shape IS chronological order. */
export function canonicalIsoMicros(iso: string): string {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(iso);
  if (!m) return iso;
  return `${m[1]}.${(m[2] ?? "").padEnd(6, "0")}Z`;
}

/**
 * The ordering the SQL predicate implements, as a pure function: true when
 * `row` comes strictly AFTER `cursor` in (lastPurchaseAt DESC, phone DESC),
 * i.e. `(row.lastPurchaseAt, row.phone) < (cursor.lastPurchaseAt, cursor.phone)`.
 *
 * This is the reference the unit test pins the codec against — the route
 * itself lets Postgres evaluate the same tuple comparison. If the SQL and
 * this function ever disagree, the SQL is wrong.
 */
export function isAfterCustomerCursor(
  row: CustomerCursor,
  cursor: CustomerCursor,
): boolean {
  const a = canonicalIsoMicros(row.lastPurchaseAt);
  const b = canonicalIsoMicros(cursor.lastPurchaseAt);
  if (a !== b) return a < b;
  return row.phone < cursor.phone;
}
