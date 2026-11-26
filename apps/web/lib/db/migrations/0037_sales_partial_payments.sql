-- Partial payments on sales — receivables tracking.
--
-- Before this migration, `sales.is_paid` is a binary: a sale is either
-- fully paid or fully unpaid. To support partial payments (customer pays
-- 5,000 on a 10,000 deferred receipt and owes 5,000), we add:
--
--   amount_paid       — running total paid against this sale
--   partial_paid_at   — timestamp of the most-recent payment that didn't
--                       fully settle the row (null when paid in full or
--                       totally unpaid)
--
-- Invariants:
--   - 0 <= amount_paid <= total_price (enforced by CHECK)
--   - is_paid mirrors `amount_paid >= total_price` (we keep the column for
--     back-compat with existing filters/queries; future code should derive
--     "paid" from amount_paid).
--
-- Backfill: existing rows with is_paid=true get amount_paid = total_price;
-- the rest stay at 0. partial_paid_at stays null for both — there's no
-- partial-payment history before this migration.
--
-- Receivables semantics post-migration: any sale with
--   total_price - amount_paid > 0  AND  is_returned = false
-- counts as outstanding, regardless of payment_method. This lets us catch
-- the cash-but-short edge case too (cashier rang a sale and forgot to
-- collect the change in full).

ALTER TABLE "sales"
  ADD COLUMN IF NOT EXISTS "amount_paid"     numeric(14,2) NOT NULL DEFAULT 0
                                              CHECK ("amount_paid" >= 0),
  ADD COLUMN IF NOT EXISTS "partial_paid_at" timestamptz;

-- Backfill in place. CAST is required because `total_price` is stored as
-- text (drizzle convention for numerics) but the new column is numeric.
UPDATE "sales"
   SET "amount_paid" = CAST("total_price" AS numeric(14,2))
 WHERE "is_paid" = true
   AND "amount_paid" = 0;

-- Enforce the upper bound only after backfill so the UPDATE doesn't race
-- the constraint check on rows where amount_paid was set to total_price.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_amount_paid_lte_total"
  CHECK ("amount_paid" <= CAST("total_price" AS numeric(14,2)));

-- Index supports the new receivables query: "fetch outstanding sales for
-- this tenant ordered by sale_date" — drives the customer-detail unpaid
-- list and the customers-page top-debtors panel.
CREATE INDEX IF NOT EXISTS "sales_tenant_outstanding_idx"
  ON "sales" ("tenant_id", "sale_date")
  WHERE "is_returned" = false
    AND "is_paid"     = false;
