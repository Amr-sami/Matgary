-- Multi-branch foundation. Adds branches + per-branch inventory and threads
-- branch_id through the operational tables (sales, expenses, purchase_orders,
-- attendance_events, store_locations, activity_logs). Backfills every
-- existing tenant with a primary branch and points all historical rows at it
-- so legacy data renders sensibly the moment the new code ships.
--
-- Rollout pattern is multi-step on purpose: this migration adds branch_id
-- columns as NULLABLE so writers can be updated incrementally without
-- breaking inserts. A follow-up migration will tighten to NOT NULL once every
-- writer plumbs the active-branch context (see task.md "Multi-branch phase 5").

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. branches
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "branches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "address" text,
  "phone" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "is_primary" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX "branches_tenant_idx" ON "branches" USING btree ("tenant_id");
--> statement-breakpoint

-- Exactly one primary branch per tenant. A second `is_primary = true` insert
-- for the same tenant fails the unique constraint instead of silently
-- creating a second one.
CREATE UNIQUE INDEX "branches_one_primary_per_tenant_idx"
  ON "branches" ("tenant_id")
  WHERE "is_primary" = true;
--> statement-breakpoint

ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "branches_tenant_isolation" ON "branches"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Seed: every existing tenant gets a primary branch named "الفرع الرئيسي".
INSERT INTO "branches" ("tenant_id", "name", "is_primary")
SELECT id, 'الفرع الرئيسي', true FROM "tenants";
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. tenant_members.branch_ids — per-staff branch allow-list
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "tenant_members"
  ADD COLUMN "branch_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint

-- Backfill every existing member with [primary_branch_id]. Owners ignore the
-- column at runtime (they implicitly see all branches), but populating it
-- keeps the array shape consistent across every row.
UPDATE "tenant_members" tm
SET "branch_ids" = ARRAY[(SELECT id FROM "branches" b WHERE b.tenant_id = tm.tenant_id AND b.is_primary LIMIT 1)]
WHERE EXISTS (SELECT 1 FROM "branches" b WHERE b.tenant_id = tm.tenant_id AND b.is_primary);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. product_stock — per-(product, branch) inventory
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "product_stock" (
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE RESTRICT,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "quantity" integer NOT NULL DEFAULT 0,
  "low_stock_threshold" integer,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("product_id", "branch_id")
);
--> statement-breakpoint

CREATE INDEX "product_stock_branch_idx" ON "product_stock" USING btree ("branch_id");
--> statement-breakpoint
CREATE INDEX "product_stock_tenant_idx" ON "product_stock" USING btree ("tenant_id");
--> statement-breakpoint

ALTER TABLE "product_stock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_stock" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_stock_tenant_isolation" ON "product_stock"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Backfill existing inventory: every product's current quantity is attributed
-- to that tenant's primary branch.
INSERT INTO "product_stock" ("product_id", "branch_id", "tenant_id", "quantity", "low_stock_threshold")
SELECT
  p.id,
  (SELECT id FROM "branches" b WHERE b.tenant_id = p.tenant_id AND b.is_primary LIMIT 1),
  p.tenant_id,
  p.quantity,
  NULL
FROM "products" p;
--> statement-breakpoint

-- Trigger keeps products.quantity in sync with the sum of product_stock.
-- Defined SECURITY DEFINER so the cross-table update is not blocked if the
-- caller's RLS context doesn't include products (e.g. an admin-side script);
-- the function only ever updates the single product whose stock just moved,
-- so there is no cross-tenant leak.
CREATE OR REPLACE FUNCTION sync_product_total_quantity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  pid uuid;
BEGIN
  pid := COALESCE(NEW.product_id, OLD.product_id);
  UPDATE products
  SET quantity = COALESCE(
    (SELECT SUM(quantity) FROM product_stock WHERE product_id = pid),
    0
  ),
  updated_at = now()
  WHERE id = pid;
  RETURN NULL;
END;
$fn$;
--> statement-breakpoint

CREATE TRIGGER product_stock_sync_after_change
AFTER INSERT OR UPDATE OF quantity OR DELETE ON product_stock
FOR EACH ROW
EXECUTE FUNCTION sync_product_total_quantity();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. branch_id on operational tables (NULLABLE for now; see header comment)
-- ─────────────────────────────────────────────────────────────────────────────

-- 4a. sales
ALTER TABLE "sales"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "sales" s
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = s.tenant_id AND b.is_primary LIMIT 1)
WHERE s."branch_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "sales_tenant_branch_date_idx" ON "sales" USING btree ("tenant_id", "branch_id", "sale_date");
--> statement-breakpoint

-- 4b. expenses (deliberately stays nullable — tenant-wide expenses use NULL)
ALTER TABLE "expenses"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
-- Existing rows were recorded before multi-branch — attribute to primary so
-- per-branch P&L still adds up. Owners can null any of these out post-hoc to
-- mark them tenant-wide.
UPDATE "expenses" e
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = e.tenant_id AND b.is_primary LIMIT 1)
WHERE e."branch_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "expenses_tenant_branch_date_idx" ON "expenses" USING btree ("tenant_id", "branch_id", "date");
--> statement-breakpoint

-- 4c. purchase_orders
ALTER TABLE "purchase_orders"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "purchase_orders" po
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = po.tenant_id AND b.is_primary LIMIT 1)
WHERE po."branch_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_branch_date_idx" ON "purchase_orders" USING btree ("tenant_id", "branch_id", "order_date");
--> statement-breakpoint

-- 4d. attendance_events
ALTER TABLE "attendance_events"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "attendance_events" ae
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = ae.tenant_id AND b.is_primary LIMIT 1)
WHERE ae."branch_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "attendance_tenant_branch_time_idx" ON "attendance_events" USING btree ("tenant_id", "branch_id", "occurred_at");
--> statement-breakpoint

-- 4e. store_locations (geofence pins) — branch_id stays nullable forever; a
-- pin without a branch is treated as tenant-wide.
ALTER TABLE "store_locations"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "store_locations" sl
SET "branch_id" = (SELECT id FROM "branches" b WHERE b.tenant_id = sl.tenant_id AND b.is_primary LIMIT 1)
WHERE sl."branch_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "store_locations_branch_idx" ON "store_locations" USING btree ("branch_id");
--> statement-breakpoint

-- 4f. activity_logs (context only — no backfill needed)
ALTER TABLE "activity_logs"
  ADD COLUMN "branch_id" uuid REFERENCES "branches"("id") ON DELETE SET NULL;
