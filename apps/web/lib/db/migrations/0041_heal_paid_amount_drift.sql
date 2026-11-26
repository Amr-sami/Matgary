-- Heal sales where is_paid=true but amount_paid < total_price.
--
-- Root cause: pre-rebalance updateSale (before the patch in this batch)
-- mutated total_price without touching amount_paid. When the owner edited
-- a fully-paid sale to nudge its price upward, is_paid stayed true while
-- amount_paid lagged behind — producing phantom outstanding balances on
-- the customer ledger (sum(total_price - amount_paid) was non-zero even
-- though every invoice card showed "مدفوع").
--
-- The new updateSale rebalances amount_paid alongside total_price so
-- this can't recur. This migration cleans up the rows that drifted
-- under the old code by bringing amount_paid back to total_price for
-- any sale flagged paid — that matches what the cashier intended when
-- they marked the sale paid in the first place.

UPDATE sales
   SET amount_paid = CAST(total_price AS numeric(14,2))
 WHERE is_paid     = true
   AND is_returned = false
   AND amount_paid < total_price;
