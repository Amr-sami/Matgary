-- Durable idempotency for POST /api/sales/cart (doc 14 §10 M3).
--
-- The offline outbox retries a cart under the same Idempotency-Key. Until now
-- the only record of "this key was already booked" lived in Redis (24h TTL),
-- so a Redis flush, a failover, or a retry after the TTL booked the cart a
-- second time. The key now also lands on the sale itself.
--
-- A cart is one row per line, all sharing invoice_id. The key is written on
-- the cart's FIRST row only (the "anchor"), so a plain partial UNIQUE on
-- (tenant_id, idempotency_key) is enough: the anchor is the first INSERT of
-- the transaction, and a duplicate aborts it before any other line — or any
-- stock decrement — commits. The route maps the 23505 to the existing cart.
--
-- Additive: nullable column, partial index; every existing row stays NULL.
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tenant_idempotency_key_idx"
  ON "sales" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
