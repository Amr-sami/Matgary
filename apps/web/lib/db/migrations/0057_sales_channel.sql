-- Sales channel: distinguish store (in-person at the till) from online
-- (WhatsApp / Instagram / phone orders) so analytics can split both figures
-- without conflating them. Owner's request, 2026-11-01.
--
-- One text column with a CHECK constraint pinning the enum values; defaulted
-- to 'store' so every historical row (pre-this-migration) backfills to
-- in-person. 'store' is the correct retrospective label for this tenant —
-- online sales did not exist in the product before today. Written on every
-- sale row of a cart (not just the anchor), matching how payment_method and
-- customer_phone are stored on every line already.
--
-- Index: (tenant_id, channel, sale_date) powers the two aggregates the
-- dashboard and insights now report ("today's sales by channel" + "sales
-- over time by channel") in one scan each.
--
-- Additive and safe to replay: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF
-- NOT EXISTS are both no-ops on a re-run.
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "channel" text NOT NULL DEFAULT 'store';
--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT IF EXISTS "sales_channel_check";
--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_channel_check" CHECK ("channel" IN ('store','online'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_channel_date_idx"
  ON "sales" ("tenant_id", "channel", "sale_date");
