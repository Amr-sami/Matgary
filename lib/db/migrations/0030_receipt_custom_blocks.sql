-- Receipt designer v2: owner can add arbitrary text blocks on top of the
-- six fixed sections, and the purchase date/time is now its own movable
-- block (was previously baked into "items").
--
-- receipt_custom_blocks shape:
--   { "<id>": { "text": "<arabic or english>", "align": "right"|"center"|"left" } }
-- The receipt_block_order array (added in 0029) may contain entries shaped
-- like "custom:<id>" — the renderer looks them up here.
--
-- "purchaseDate" is now a known fixed key; existing tenants on a stored
-- order will still get it (normalizeBlockOrder() in lib/repo/settings.ts
-- appends any default key that wasn't in the stored array, so the date
-- shows up automatically at the end of the order until the owner moves it).

ALTER TABLE "shop_settings"
  ADD COLUMN IF NOT EXISTS "receipt_custom_blocks" jsonb NOT NULL DEFAULT '{}'::jsonb;
