-- Multi-store isolation. Promotes branches from a "chain store" model
-- (shared catalog, per-branch sales/stock) to a "franchise / sub-tenant"
-- model where every branch operates as an independent shop. The owner's
-- billing account stays single but everything else (catalog, employees,
-- customers, suppliers, tasks, leaves, settings) becomes branch-scoped.
--
-- Migration semantics:
--   - Every existing row in a now-branched table is attached to the tenant's
--     primary branch (the one created by 0014_multi_branch).
--   - Branches added later start completely empty — no products, no
--     categories, no employees. The owner sets them up from scratch.
--   - Old per-(product, branch) inventory table (product_stock) is dropped.
--     Products now carry branch_id directly with their own quantity.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. branches.slug — used in URLs and as a stable identifier
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "branches" ADD COLUMN "slug" text;
--> statement-breakpoint

-- Backfill: derive a slug from the name; force "main" for the primary so
-- existing data gets a recognisable URL piece. Non-primary branches get a
-- random suffix to guarantee uniqueness within the tenant.
UPDATE "branches"
SET "slug" = 'main'
WHERE "is_primary" = true;
--> statement-breakpoint

UPDATE "branches"
SET "slug" = lower(
  regexp_replace(
    coalesce("name", 'branch'),
    '[^a-zA-Z0-9]+',
    '-',
    'g'
  )
) || '-' || substr(md5(random()::text), 1, 6)
WHERE "slug" IS NULL;
--> statement-breakpoint

ALTER TABLE "branches" ALTER COLUMN "slug" SET NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX "branches_tenant_slug_idx"
  ON "branches" ("tenant_id", "slug");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. categories per-branch
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "categories"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "categories" c
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = c.tenant_id AND b.is_primary LIMIT 1)
WHERE c."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "categories_branch_idx" ON "categories" ("branch_id");
--> statement-breakpoint

-- 3. brands per-branch
ALTER TABLE "brands"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "brands" b
SET "branch_id" = (SELECT id FROM "branches" br WHERE br.tenant_id = b.tenant_id AND br.is_primary LIMIT 1)
WHERE b."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "brands" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "brands_branch_idx" ON "brands" ("branch_id");
--> statement-breakpoint

-- 4. category_attributes inherit from their category's branch
ALTER TABLE "category_attributes"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "category_attributes" ca
SET "branch_id" = (SELECT c.branch_id FROM "categories" c WHERE c.id = ca.category_id)
WHERE ca."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "category_attributes" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "category_attributes_branch_idx" ON "category_attributes" ("branch_id");
--> statement-breakpoint

-- 5. category_attribute_values inherit from their attribute's branch
ALTER TABLE "category_attribute_values"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "category_attribute_values" cav
SET "branch_id" = (SELECT ca.branch_id FROM "category_attributes" ca WHERE ca.id = cav.attribute_id)
WHERE cav."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "category_attribute_values" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "category_attribute_values_branch_idx" ON "category_attribute_values" ("branch_id");
--> statement-breakpoint

-- 6. products per-branch (the big one). Each product belongs to one branch.
-- The chain-store-era product_stock table goes away — products.quantity is
-- now the per-branch on-hand count, no trigger needed.
ALTER TABLE "products"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "products" p
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = p.tenant_id AND b.is_primary LIMIT 1)
WHERE p."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "products_branch_idx" ON "products" ("branch_id");
--> statement-breakpoint

-- Drop the chain-store inventory machinery. The trigger first (depends on
-- the table), then the table, then the function.
DROP TRIGGER IF EXISTS product_stock_sync_after_change ON "product_stock";
--> statement-breakpoint
DROP TABLE IF EXISTS "product_stock";
--> statement-breakpoint
DROP FUNCTION IF EXISTS sync_product_total_quantity();
--> statement-breakpoint

-- product_attribute_values gets a branch column too — every PAV row is tied
-- to a (product, attribute) pair which both now have branch_id. We mirror it
-- so RLS / queries don't need a join to filter.
ALTER TABLE "product_attribute_values"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "product_attribute_values" pav
SET "branch_id" = (SELECT p.branch_id FROM "products" p WHERE p.id = pav.product_id)
WHERE pav."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "product_attribute_values" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "product_attribute_values_branch_idx" ON "product_attribute_values" ("branch_id");
--> statement-breakpoint

-- 7. suppliers per-branch
ALTER TABLE "suppliers"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "suppliers" s
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = s.tenant_id AND b.is_primary LIMIT 1)
WHERE s."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "suppliers" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "suppliers_branch_idx" ON "suppliers" ("branch_id");
--> statement-breakpoint

-- 8. tasks per-branch
ALTER TABLE "tasks"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "tasks" t
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = t.tenant_id AND b.is_primary LIMIT 1)
WHERE t."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "tasks_branch_idx" ON "tasks" ("branch_id");
--> statement-breakpoint

-- 9. leave_requests per-branch
ALTER TABLE "leave_requests"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "leave_requests" lr
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = lr.tenant_id AND b.is_primary LIMIT 1)
WHERE lr."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "leave_requests" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "leave_requests_branch_idx" ON "leave_requests" ("branch_id");
--> statement-breakpoint

-- 10. notifications per-branch (so a staff member at branch A doesn't see
--     branch B's notifications even if they later get reassigned)
ALTER TABLE "notifications"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE "notifications" n
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = n.tenant_id AND b.is_primary LIMIT 1)
WHERE n."branch_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "notifications_branch_idx" ON "notifications" ("branch_id");
--> statement-breakpoint

-- 11. shop_settings — change PK from (tenant_id) to (tenant_id, branch_id).
-- The existing row for each tenant becomes that tenant's primary-branch
-- settings. New branches start with a blank settings row inserted on the
-- fly when they're created (handled in the application).
ALTER TABLE "shop_settings"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE "shop_settings" s
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = s.tenant_id AND b.is_primary LIMIT 1)
WHERE s."branch_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "shop_settings" ALTER COLUMN "branch_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "shop_settings" DROP CONSTRAINT IF EXISTS "shop_settings_pkey";
--> statement-breakpoint
ALTER TABLE "shop_settings" ADD PRIMARY KEY ("tenant_id", "branch_id");
--> statement-breakpoint

-- 12. tenant_members: collapse branch_ids[] (allow-list) into a single
-- branch_id (where the staff member works). Owner role stays free to
-- switch — branch_id is NULL for owners.
ALTER TABLE "tenant_members"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- Backfill: take the first id from the existing branch_ids array. Owners
-- stay NULL — they implicitly see every branch.
UPDATE "tenant_members"
SET "branch_id" = "branch_ids"[1]
WHERE "role" != 'owner' AND array_length("branch_ids", 1) >= 1;
--> statement-breakpoint

-- Owners explicitly set to NULL so the picker logic is clean.
UPDATE "tenant_members"
SET "branch_id" = NULL
WHERE "role" = 'owner';
--> statement-breakpoint

CREATE INDEX "tenant_members_branch_idx" ON "tenant_members" ("branch_id");
--> statement-breakpoint

-- We keep the legacy branch_ids[] column for one more deploy in case any
-- read path slipped past the refactor; a follow-up migration drops it once
-- production logs show no further references.
