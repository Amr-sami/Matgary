-- Phase 6: per-(tenant, branch) receipt-template selection.
--
-- When BOTH columns are set, the SaleForm receipt path uses the
-- Meta-approved template instead of sending a PDF. The template MUST
-- accept exactly four body parameters in this order:
--   {{1}} customerName
--   {{2}} invoiceCode  (last 8 of invoice id, uppercased)
--   {{3}} totalPrice   (already-formatted EGP string)
--   {{4}} productNames (comma-separated list)
--
-- Operators approve the template once in Meta Business Manager, sync it
-- via /api/whatsapp/templates/sync, and pick it in settings.

ALTER TABLE "shop_settings"
  ADD COLUMN IF NOT EXISTS "receipt_template_name" text;
--> statement-breakpoint
ALTER TABLE "shop_settings"
  ADD COLUMN IF NOT EXISTS "receipt_template_language" text;
