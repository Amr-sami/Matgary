-- Receipt designer: owner-customisable layout for the printed/shared receipt.
--
-- Two new columns on shop_settings:
--   * receipt_block_order — JSONB array of block keys in render order.
--     Known keys: "logo", "shopInfo", "items", "totals", "loyalty", "footer".
--     NULL means "use default order" so existing tenants render unchanged.
--   * receipt_font_family — one of "cairo" | "tajawal" | "lemonada".
--     Cairo is the body default; the others are already loaded by app/layout.
--
-- The logo URL itself re-uses the long-existing `logo_path` column (added
-- in an earlier migration but never wired up). It stores a `data:image/...`
-- URI so we don't need any blob-storage infra for v1; capped at ~256 KB at
-- the API layer.

ALTER TABLE "shop_settings"
  ADD COLUMN IF NOT EXISTS "receipt_block_order" jsonb;
--> statement-breakpoint
ALTER TABLE "shop_settings"
  ADD COLUMN IF NOT EXISTS "receipt_font_family" text NOT NULL DEFAULT 'cairo';
