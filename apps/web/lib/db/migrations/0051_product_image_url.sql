-- Product photos (doc 02 §1.1 row 4). Stores the relative URL minted by
-- POST /api/uploads/product-image (uploads/<tenant>/products/<uuid>.<ext>
-- on disk, served by GET /api/uploads/product-image/<tenant>/products/…).
-- Nullable: the vast majority of rows have no photo.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "image_url" text;
