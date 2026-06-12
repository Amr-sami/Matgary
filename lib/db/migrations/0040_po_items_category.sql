-- purchase_order_items.category_id — capture the category an OWNER picks
-- for an "external" (productId=null) PO line at PO-creation time, so the
-- receive flow files the new product correctly instead of always
-- defaulting to the tenant's first category.
--
-- Nullable: the column is meaningful ONLY for external lines; catalog-
-- picked lines (productId IS NOT NULL) already inherit the category from
-- the linked product row.
--
-- ON DELETE SET NULL on the FK so a category deletion doesn't cascade
-- through historical POs.

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS category_id uuid NULL
  REFERENCES categories(id) ON DELETE SET NULL;
