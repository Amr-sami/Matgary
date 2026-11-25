-- Per-identity-row alignment overrides on the receipt.
--
-- Stored as a JSONB map keyed by row ("name", "address", "phone", "slogan",
-- "taxReg", "taxCard", "returnPolicy", "footerText") → "left" | "center" |
-- "right". Default {} → the renderer falls back to "center" (today's shape).
--
-- A column (not six booleans or one row per key) because this list may grow
-- and because the Owner's edit is a bulk patch — one write persists any mix.
-- Not a `Record<FixedBlockKey, align>` either: shopInfo already contains
-- five sub-rows (name/phone/address/slogan/tax) whose alignments the Owner
-- wants to set separately — one flag per big block is too coarse.

ALTER TABLE "shop_settings"
    ADD COLUMN IF NOT EXISTS "receipt_block_alignments" jsonb NOT NULL DEFAULT '{}'::jsonb;
