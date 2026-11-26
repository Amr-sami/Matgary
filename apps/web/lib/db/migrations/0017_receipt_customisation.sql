-- Receipt customisation. Per-branch (multi-store): each store can have
-- its own logo size, footer copy, language preference, and loyalty
-- visibility on the printed/shared receipts.
--
-- All defaults match the current behaviour so this migration is a no-op
-- visually until the owner opens the new settings card and changes
-- something. That keeps existing receipts untouched after deploy.

-- Logo on the receipt — owner controls the rendered size (or hides it
-- entirely for shops that print to thermal printers where the logo
-- prints poorly). 'medium' matches today's default rendering.
ALTER TABLE "shop_settings"
  ADD COLUMN "receipt_logo_size" text NOT NULL DEFAULT 'medium';
--> statement-breakpoint

-- Free-form footer text rendered at the bottom of every receipt. Lets
-- owners add a return policy, social handle, or thank-you message
-- without us having to ship a separate setting per use case.
-- Multi-line via embedded \n.
ALTER TABLE "shop_settings"
  ADD COLUMN "receipt_footer_text" text NOT NULL DEFAULT '';
--> statement-breakpoint

-- Receipt language. 'ar' = Arabic only (current behaviour), 'en' =
-- English only (for tourists / B2B), 'bilingual' = labels in both
-- languages side-by-side (e.g. "الإجمالي / Total"). Application
-- enforces the enum at the route level.
ALTER TABLE "shop_settings"
  ADD COLUMN "receipt_language" text NOT NULL DEFAULT 'ar';
--> statement-breakpoint

-- When true AND loyalty is enabled for the branch, the receipt shows
-- "earned X points" / "redeemed Y points" lines so the customer is
-- reminded of the programme at the point of sale (one of the strongest
-- adoption levers for loyalty programmes).
ALTER TABLE "shop_settings"
  ADD COLUMN "receipt_show_loyalty" boolean NOT NULL DEFAULT true;
