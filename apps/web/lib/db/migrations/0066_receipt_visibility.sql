-- Receipt per-field visibility toggles.
--
-- Owners already can hide a row by clearing its text ("empty = hidden" is the
-- renderer's default). These booleans let them TEMPORARILY hide a filled-in
-- field — e.g. suppress the return policy during a promo period — without
-- losing the text they typed. Default TRUE so existing tenants see no change.
--
-- Scope is intentionally narrow: four fields where "show text, keep it hidden"
-- is a plausible owner need. Phone / name / address of the SHOP already live
-- behind `shopPhone` / `shopName` text columns where "empty = hidden" is the
-- right semantics; adding bool toggles for those would be redundant.

ALTER TABLE "shop_settings"
    ADD COLUMN IF NOT EXISTS "receipt_show_address"       boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "receipt_show_slogan"        boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "receipt_show_tax_info"      boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "receipt_show_return_policy" boolean NOT NULL DEFAULT true;
