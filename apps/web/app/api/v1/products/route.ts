import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { listProducts } from "@/lib/repo/catalog";
import { normalizeSku } from "@/lib/sales/scan-cart";
import type { Product } from "@/lib/types";

// Server-side catalogue lookup for the native client.
//
// The web POS can only resolve a scanned code against a catalogue it already
// downloaded in full (see lib/sales/scan-cart.ts, which filters an in-memory
// Product[]). A phone cannot hold the whole catalogue, so scan-to-cart needs a
// lookup that lives on the server. That is what this route is.
//
// Lookup modes, in strict precedence order:
//   ?barcode=  exact, scanner path, at most ONE product back
//   ?sku=      exact, catalogue-identifier path, every match
//   ?q=        partial across name / sku / brand
// Precedence matters because the scanner can legitimately fire while a search
// box still holds text; the physical scan must always win.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;

const querySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  barcode: z.string().trim().min(1).max(120).optional(),
  sku: z.string().trim().min(1).max(120).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
});

// ─────────────────────────────────────────────────────────────────────────────
// Cursor — (createdAt, id) tuple, same shape as listSalesPage's.
//
// An offset cursor would be cheaper here (we page in memory) but it silently
// skips or repeats rows when a product is added between two pages. The tuple
// is stable against inserts because listProducts orders by createdAt DESC.
// ─────────────────────────────────────────────────────────────────────────────

function encodeCursor(p: Product): string {
  return `${p.createdAt.toISOString()}:${p.id}`;
}

function decodeCursor(raw: string | undefined): { at: number; id: string } | null {
  if (!raw) return null;
  // lastIndexOf, NOT indexOf: the timestamp half is an ISO string and it
  // contains its own colons ("…T14:45:44.873Z"). Splitting on the first one
  // yielded "2026-09-14T14" -> NaN -> a null cursor that the caller silently
  // ignored, so every page came back as page 1 and a scrolling client looped
  // forever. A uuid contains no colon, so the last one is always the delimiter.
  const i = raw.lastIndexOf(":");
  if (i < 0) return null;
  const at = new Date(raw.slice(0, i)).getTime();
  const id = raw.slice(i + 1);
  if (Number.isNaN(at) || !id) return null;
  return { at, id };
}

/** True for rows that come strictly AFTER the cursor row in (createdAt DESC, id DESC). */
function isAfterCursor(p: Product, cur: { at: number; id: string }): boolean {
  const at = p.createdAt.getTime();
  if (at !== cur.at) return at < cur.at;
  return p.id < cur.id;
}

/**
 * Case-insensitive contains. Arabic is unaffected by toLowerCase, and product
 * names here are Arabic-first, so this only ever changes Latin brand/SKU text —
 * which is exactly where cashiers type inconsistent case.
 */
function contains(haystack: string | undefined | null, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle);
}

export async function GET(req: NextRequest) {
  // Branch-scoped: a scan at the Nasr City till must never resolve to the
  // Maadi branch's copy of the product — the two rows carry separate stock.
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // Machine code, never the zod message: a native client keys retry
    // behaviour off this string and must not have to parse English prose.
    return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400 });
  }
  const { q, barcode, sku, cursor, limit } = parsed.data;

  // Deliberately NOT cached and deliberately the same repo function the web
  // list route uses: product.quantity decrements on every sale, and the native
  // POS decides whether a scan is sellable from the quantity in this response.
  //
  // Reusing listProducts also keeps one definition of a Product's shape
  // (attribute snapshots, linked-supplier name resolution). The cost is that a
  // scan reads the branch's catalogue rather than one indexed row; when a
  // tenant's catalogue grows past the point where that hurts, the fix is a
  // findProductBySku() in lib/repo/catalog.ts, not a hand-rolled query here.
  const all = await listProducts(r.ctx.tenantId, r.ctx.branchId);

  if (barcode) {
    const match = matchBarcode(all, barcode);
    // Zero matches is a 200, not a 404. "No product with this barcode" is the
    // normal first half of the add-product flow — the POS offers to create one.
    // A 404 would make every native HTTP layer treat it as a failure and
    // trigger retry/offline handling for a perfectly successful lookup.
    return NextResponse.json({
      data: match.chosen ? [match.chosen] : [],
      nextCursor: null,
      // The true match count, which can exceed data.length: two branch-local
      // rows can share a barcode. The POS shows the one we picked and can fall
      // back to ?sku= to list them all when total > 1.
      total: match.total,
    });
  }

  let matched: Product[];
  if (sku) {
    // Exact on SKU — but trimmed and case-folded. The write path only trims, so
    // "AB-100" and "ab-100 " are the same catalogue entry to a human and must
    // be the same entry here. No UPC-A collapsing: that is a barcode-encoding
    // rule, and applying it to a plain SKU would make a 13-digit SKU and a
    // 12-digit one collide.
    const target = sku.toLowerCase();
    matched = all.filter((p) => (p.sku ?? "").trim().toLowerCase() === target);
  } else if (q) {
    const needle = q.toLowerCase();
    matched = all.filter(
      (p) =>
        contains(p.name, needle) ||
        contains(p.sku, needle) ||
        contains(p.brand, needle),
    );
  } else {
    matched = all;
  }

  const cur = decodeCursor(cursor);
  // A cursor we cannot parse is rejected rather than ignored. Silently
  // restarting at page 1 is what let the decode bug above go unnoticed: the
  // client kept asking for the next page and kept being handed the first one.
  if (cursor && !cur) {
    return NextResponse.json({ error: "INVALID_CURSOR" }, { status: 400 });
  }

  // Impose the TOTAL order the cursor predicate assumes. listProducts orders
  // by createdAt DESC only, with no tiebreak, so rows sharing a createdAt come
  // back in whatever order Postgres felt like — and a bulk import or a seed
  // gives an entire catalogue one identical createdAt. Without this sort the
  // (createdAt, id) keyset filters against an order that does not exist and
  // silently drops rows: page 2 of a 24-product catalogue came back empty.
  const ordered = matched.slice().sort((a, b) => {
    const d = b.createdAt.getTime() - a.createdAt.getTime();
    if (d !== 0) return d;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // id DESC
  });

  const page = (cur ? ordered.filter((p) => isAfterCursor(p, cur)) : ordered).slice(
    0,
    limit + 1,
  );
  const hasMore = page.length > limit;
  const data = hasMore ? page.slice(0, limit) : page;

  return NextResponse.json({
    data,
    nextCursor: hasMore ? encodeCursor(data[data.length - 1]!) : null,
    // Total across the whole filtered set, not the page — the POS renders
    // "12 نتيجة" without walking every page.
    total: matched.length,
  });
}

/**
 * Resolve a scanned code to at most one product.
 *
 * Normalisation is `normalizeSku` imported verbatim from lib/sales/scan-cart.ts
 * — the SAME function the web scanner uses — rather than a re-implementation or
 * a SQL equivalent. It strips invisible decoder junk (NUL, control bytes, BOM,
 * zero-width joiners), case-folds, and collapses UPC-A ↔ EAN-13: a 12-digit
 * UPC-A and the 13-digit EAN-13 that is the same code with a leading "0" both
 * reduce to the same 12 digits. It is applied to BOTH sides — the scanned query
 * AND each stored sku — because either side may be the one holding the leading
 * zero, depending on whether the code was keyed in by hand or captured by a
 * decoder. Sharing the function is the point: if the rule ever changes, the web
 * and the phone cannot drift apart and produce different scan results.
 */
function matchBarcode(
  all: Product[],
  raw: string,
): { chosen: Product | null; total: number } {
  const target = normalizeSku(raw);
  if (!target) return { chosen: null, total: 0 };

  const matches = all.filter((p) => normalizeSku(p.sku ?? "") === target);
  if (matches.length === 0) return { chosen: null, total: 0 };

  // Stock is NOT a filter, only a tiebreak. Returning nothing for a product
  // that exists at qty 0 is the bug lib/sales/scan-cart.ts calls out: the
  // cashier is told "not found" and creates a duplicate, when the right answer
  // is "this exists, top up the stock". So an out-of-stock row still comes
  // back, with quantity 0 for the client to act on.
  const inStock = matches.filter((p) => p.quantity > 0);
  const pool = inStock.length > 0 ? inStock : matches;
  return { chosen: pool[0]!, total: matches.length };
}
