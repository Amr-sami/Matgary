-- Receipt identity fields (Owner receipt customization).
--
-- Six optional text columns on the existing shop_settings table. Every field
-- is nullable; when the Owner leaves it blank the renderer omits the row
-- entirely rather than printing an empty line, placeholder or fake value.
--
-- Why on shop_settings and not a new table: the receipt renderer already
-- reads one row per (tenant, branch) and renders a configurable block list
-- from that row. Splitting six scalars into their own table would add a join
-- on every receipt render and a second cache invalidation path for no
-- payoff — these fields have the same lifecycle as logoPath, slogan and
-- footer text.
--
-- All fields are purely presentational: historical sales never change when
-- the Owner edits them. Tax numbers are text (not validated) because the
-- Egyptian tax format (رقم السجل التجاري / البطاقة الضريبية) varies by
-- governorate; validating here would reject valid strings.

ALTER TABLE "shop_settings"
    ADD COLUMN IF NOT EXISTS "receipt_tax_registration" text,
    ADD COLUMN IF NOT EXISTS "receipt_tax_card_number"  text,
    ADD COLUMN IF NOT EXISTS "receipt_slogan"           text,
    ADD COLUMN IF NOT EXISTS "receipt_return_policy"    text,
    ADD COLUMN IF NOT EXISTS "receipt_address"          text,
    -- Short uppercase alphanumeric prefix the renderer stamps in front of
    -- the invoice short-code at the footer ("INV-A1B2C3" vs "A1B2C3").
    -- Max 8 chars in the UI; column cap intentionally generous.
    ADD COLUMN IF NOT EXISTS "receipt_reference_prefix" text;
