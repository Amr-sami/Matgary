-- Inventory Count (جرد) tables — tenant-isolated, no branches.
-- Applied directly because drizzle-kit's full-schema regen collides with
-- live tables; this file is the exact additive set for 3 new tables.

CREATE TABLE IF NOT EXISTS "inventory_counts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "tenant_id" uuid NOT NULL,
    "scope_kind" text NOT NULL,
    "scope_value" text,
    "status" text NOT NULL DEFAULT 'draft',
    "scope_product_count" integer NOT NULL DEFAULT 0,
    "created_by_user_id" uuid NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "confirmed_at" timestamp with time zone,
    "confirmed_by_user_id" uuid,
    "confirm_idempotency_key" text,
    "cancelled_at" timestamp with time zone,
    "cancelled_by_user_id" uuid
);

ALTER TABLE "inventory_counts"
    ADD CONSTRAINT "inventory_counts_tenant_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
ALTER TABLE "inventory_counts"
    ADD CONSTRAINT "inventory_counts_created_by_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE restrict;
ALTER TABLE "inventory_counts"
    ADD CONSTRAINT "inventory_counts_confirmed_by_fk"
    FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE set null;
ALTER TABLE "inventory_counts"
    ADD CONSTRAINT "inventory_counts_cancelled_by_fk"
    FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE UNIQUE INDEX "inventory_counts_idem_uq"
    ON "inventory_counts" ("tenant_id", "confirm_idempotency_key")
    WHERE "confirm_idempotency_key" IS NOT NULL;
CREATE INDEX "inventory_counts_tenant_status_idx"
    ON "inventory_counts" ("tenant_id", "status", "created_at");

CREATE TABLE IF NOT EXISTS "inventory_count_lines" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "count_id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "product_id" uuid NOT NULL,
    "baseline_qty" integer NOT NULL,
    "counted_qty" integer,
    "counted_at" timestamp with time zone,
    "counted_by_user_id" uuid,
    "source" text,
    "added_mid_count" boolean NOT NULL DEFAULT false,
    "product_missing_at_confirm" boolean NOT NULL DEFAULT false,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "inventory_count_lines"
    ADD CONSTRAINT "inventory_count_lines_count_id_fk"
    FOREIGN KEY ("count_id") REFERENCES "inventory_counts"("id") ON DELETE cascade;
ALTER TABLE "inventory_count_lines"
    ADD CONSTRAINT "inventory_count_lines_tenant_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
ALTER TABLE "inventory_count_lines"
    ADD CONSTRAINT "inventory_count_lines_counted_by_fk"
    FOREIGN KEY ("counted_by_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE UNIQUE INDEX "inventory_count_lines_count_product_uq"
    ON "inventory_count_lines" ("count_id", "product_id");
CREATE INDEX "inventory_count_lines_count_idx"
    ON "inventory_count_lines" ("count_id");

CREATE TABLE IF NOT EXISTS "inventory_count_reconciliations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "tenant_id" uuid NOT NULL,
    "count_id" uuid NOT NULL,
    "product_id" uuid NOT NULL,
    "baseline_qty" integer NOT NULL,
    "counted_qty" integer NOT NULL,
    "counted_at" timestamp with time zone NOT NULL,
    "movement_after_count" integer NOT NULL,
    "current_qty_at_confirm" integer NOT NULL,
    "expected_physical" integer NOT NULL,
    "adjustment" integer NOT NULL,
    "product_history_id" uuid,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "inventory_count_reconciliations"
    ADD CONSTRAINT "inventory_count_recon_tenant_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
ALTER TABLE "inventory_count_reconciliations"
    ADD CONSTRAINT "inventory_count_recon_count_id_fk"
    FOREIGN KEY ("count_id") REFERENCES "inventory_counts"("id") ON DELETE cascade;

CREATE UNIQUE INDEX "inventory_count_recon_count_product_uq"
    ON "inventory_count_reconciliations" ("count_id", "product_id");
CREATE INDEX "inventory_count_recon_tenant_count_idx"
    ON "inventory_count_reconciliations" ("tenant_id", "count_id");
