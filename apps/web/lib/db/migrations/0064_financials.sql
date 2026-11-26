-- Slice 1: Financial Management foundation
--
-- Adds a hierarchical financial category tree (system + tenant custom), a
-- money_movements table for non-P&L cash movements (owner draws, loans,
-- transfers), and extends expenses with the fields the new engine needs
-- (status/void, payment method, created-by, reference). A new partial UNIQUE
-- index on (tenant_id, parent_expense_id, date) makes recurring-expense child
-- generation idempotent at the database level, not just in application code.
--
-- No branch columns anywhere — Storo has no branches. Legacy branch_id on
-- expenses is left alone (it's nullable, backward-compat).
--
-- Backfill / seed are idempotent (INSERT … ON CONFLICT DO NOTHING) so the
-- migration can run repeatedly without creating duplicates.

-- ─── 1. financial_categories ────────────────────────────────────────────────
-- Two-level category tree. `tenant_id = NULL` + `is_system = true` = seeded
-- system defaults visible to every tenant. Tenant-custom categories carry a
-- real `tenant_id`. `kind` is the P&L bucket the category hits: 'opex' lines
-- live in Operating Expenses; 'other_income' / 'other_expense' live below
-- Operating Profit. Categories have a stable `slug` so seed re-runs are safe.

CREATE TABLE IF NOT EXISTS "financial_categories" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" uuid REFERENCES "tenants"("id") ON DELETE CASCADE,
    "parent_id" uuid REFERENCES "financial_categories"("id") ON DELETE RESTRICT,
    "slug" text NOT NULL,
    "name_en" text NOT NULL,
    "name_ar" text NOT NULL,
    -- 'opex' | 'other_income' | 'other_expense'
    "kind" text NOT NULL,
    "is_system" boolean NOT NULL DEFAULT false,
    "sort_order" integer NOT NULL DEFAULT 0,
    "archived_at" timestamp with time zone,
    "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "financial_categories_kind_check"
        CHECK ("kind" IN ('opex', 'other_income', 'other_expense'))
);

-- System seeds live under (tenant_id IS NULL, slug) — unique.
CREATE UNIQUE INDEX IF NOT EXISTS "financial_categories_system_slug_idx"
    ON "financial_categories" ("slug")
    WHERE "tenant_id" IS NULL;

-- Tenant customs are unique per tenant by slug.
CREATE UNIQUE INDEX IF NOT EXISTS "financial_categories_tenant_slug_idx"
    ON "financial_categories" ("tenant_id", "slug")
    WHERE "tenant_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "financial_categories_tenant_parent_idx"
    ON "financial_categories" ("tenant_id", "parent_id");

CREATE INDEX IF NOT EXISTS "financial_categories_parent_idx"
    ON "financial_categories" ("parent_id");

-- RLS: tenant rows isolated by tenant_id; system rows (tenant_id IS NULL)
-- are visible to everyone (read-only).
ALTER TABLE "financial_categories" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "financial_categories_tenant_isolation" ON "financial_categories";
CREATE POLICY "financial_categories_tenant_isolation"
    ON "financial_categories"
    USING (
        "tenant_id" IS NULL
        OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
    )
    WITH CHECK (
        "tenant_id" IS NULL
        OR "tenant_id" = current_setting('app.tenant_id', true)::uuid
    );


-- ─── 2. money_movements ─────────────────────────────────────────────────────
-- Non-P&L cash movements. The owner-visible view of "money in / money out
-- that isn't profit or expense". Engine explicitly EXCLUDES these from every
-- P&L number, so an owner deposit never masquerades as revenue.

CREATE TABLE IF NOT EXISTS "money_movements" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
    -- 'owner_deposit' | 'owner_withdrawal' | 'cash_transfer'
    --  | 'loan_received' | 'loan_principal_repayment'
    --  | 'supplier_payment_direct' | 'customer_deposit' | 'other'
    "kind" text NOT NULL,
    -- Same numeric convention as expenses.amount — Drizzle maps text, SQL
    -- treats as numeric in aggregations.
    "amount" text NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
    "description" text,
    "payment_method" text,
    -- Optional link back to the entity this movement settles (supplier,
    -- customer, etc.). Soft reference — no FK — so a deleted supplier
    -- doesn't tear the ledger.
    "related_entity_type" text,
    "related_entity_id" uuid,
    "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "voided_at" timestamp with time zone,
    "voided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "void_reason" text,
    CONSTRAINT "money_movements_kind_check" CHECK ("kind" IN (
        'owner_deposit',
        'owner_withdrawal',
        'cash_transfer',
        'loan_received',
        'loan_principal_repayment',
        'supplier_payment_direct',
        'customer_deposit',
        'other'
    )),
    CONSTRAINT "money_movements_amount_nonneg" CHECK (("amount")::numeric >= 0)
);

CREATE INDEX IF NOT EXISTS "money_movements_tenant_date_idx"
    ON "money_movements" ("tenant_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "money_movements_tenant_kind_idx"
    ON "money_movements" ("tenant_id", "kind");

ALTER TABLE "money_movements" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "money_movements_tenant_isolation" ON "money_movements";
CREATE POLICY "money_movements_tenant_isolation"
    ON "money_movements"
    USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);


-- ─── 3. expenses additions ──────────────────────────────────────────────────
-- category_id: the new FK into financial_categories. Nullable for backward
-- compat with pre-migration rows; backfill below maps the legacy `category`
-- text enum into the new seeded rows.
-- status/voided_*: lifecycle so corrections preserve audit history.
-- payment_method / reference_number / created_by_user_id: fields the engine
-- + management UI need.

ALTER TABLE "expenses"
    ADD COLUMN IF NOT EXISTS "category_id" uuid REFERENCES "financial_categories"("id") ON DELETE RESTRICT;

ALTER TABLE "expenses"
    ADD COLUMN IF NOT EXISTS "payment_method" text;

ALTER TABLE "expenses"
    ADD COLUMN IF NOT EXISTS "reference_number" text;

ALTER TABLE "expenses"
    ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'posted';

ALTER TABLE "expenses"
    ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;

ALTER TABLE "expenses"
    ADD COLUMN IF NOT EXISTS "voided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "expenses"
    ADD COLUMN IF NOT EXISTS "void_reason" text;

ALTER TABLE "expenses"
    ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

-- status CHECK (idempotent — DO $$ … EXCEPTION pattern).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'expenses_status_check'
    ) THEN
        ALTER TABLE "expenses" ADD CONSTRAINT "expenses_status_check"
            CHECK ("status" IN ('posted', 'voided'));
    END IF;
END$$;

-- Partial UNIQUE index on recurring child idempotency. A template that
-- spawns a child for date D must never spawn a second child for the same
-- (template, date) tuple — the P&L would double-count. Partial because
-- the vast majority of expenses are one-offs (parent_expense_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS "expenses_recurring_child_unique_idx"
    ON "expenses" ("tenant_id", "parent_expense_id", "date")
    WHERE "parent_expense_id" IS NOT NULL;

-- Status filter index — the P&L excludes voided rows.
CREATE INDEX IF NOT EXISTS "expenses_tenant_status_date_idx"
    ON "expenses" ("tenant_id", "status", "date");


-- ─── 4. Seed system categories ──────────────────────────────────────────────
-- Stable UUIDs so re-runs don't duplicate. Two-level: top-level groups
-- (category) and subcategories under them (parent_id points at the group).
--
-- Groups:
--  00000000-0000-4001-0000-000000000001  People
--  00000000-0000-4001-0000-000000000002  Rent & Facilities
--  00000000-0000-4001-0000-000000000003  Utilities
--  00000000-0000-4001-0000-000000000004  Marketing
--  00000000-0000-4001-0000-000000000005  Logistics
--  00000000-0000-4001-0000-000000000006  Technology
--  00000000-0000-4001-0000-000000000007  Professional
--  00000000-0000-4001-0000-000000000008  Financial
--  00000000-0000-4001-0000-000000000009  Other

INSERT INTO "financial_categories" (id, tenant_id, parent_id, slug, name_en, name_ar, kind, is_system, sort_order)
VALUES
    -- Top-level groups.
    ('00000000-0000-4001-0000-000000000001', NULL, NULL, 'people',           'People',            'الموظفون',          'opex', true, 10),
    ('00000000-0000-4001-0000-000000000002', NULL, NULL, 'rent_facilities',  'Rent & Facilities', 'الإيجار والمرافق',  'opex', true, 20),
    ('00000000-0000-4001-0000-000000000003', NULL, NULL, 'utilities',        'Utilities',         'المرافق الخدمية',   'opex', true, 30),
    ('00000000-0000-4001-0000-000000000004', NULL, NULL, 'marketing',        'Marketing',         'التسويق',            'opex', true, 40),
    ('00000000-0000-4001-0000-000000000005', NULL, NULL, 'logistics',        'Logistics',         'الخدمات اللوجستية', 'opex', true, 50),
    ('00000000-0000-4001-0000-000000000006', NULL, NULL, 'technology',       'Technology',        'التقنية',            'opex', true, 60),
    ('00000000-0000-4001-0000-000000000007', NULL, NULL, 'professional',     'Professional',      'الخدمات المهنية',   'opex', true, 70),
    ('00000000-0000-4001-0000-000000000008', NULL, NULL, 'financial',        'Financial',         'المصاريف المالية',  'opex', true, 80),
    ('00000000-0000-4001-0000-000000000009', NULL, NULL, 'other_opex',       'Other',             'أخرى',               'opex', true, 90),
    -- Other income / other expense roots (no legacy data maps here; they are
    -- entry points for manual rows in Slice 2+).
    ('00000000-0000-4002-0000-000000000001', NULL, NULL, 'other_income',     'Other Income',      'إيرادات أخرى',       'other_income',  true, 10),
    ('00000000-0000-4003-0000-000000000001', NULL, NULL, 'other_expense',    'Other Expense',     'مصروفات أخرى',       'other_expense', true, 10),

    -- People subcategories.
    ('00000000-0000-4011-0000-000000000001', NULL, '00000000-0000-4001-0000-000000000001', 'salaries',        'Salaries',           'رواتب',            'opex', true, 10),
    ('00000000-0000-4011-0000-000000000002', NULL, '00000000-0000-4001-0000-000000000001', 'bonuses',         'Bonuses',            'مكافآت',           'opex', true, 20),
    ('00000000-0000-4011-0000-000000000003', NULL, '00000000-0000-4001-0000-000000000001', 'commissions',     'Commissions',        'عمولات',           'opex', true, 30),
    ('00000000-0000-4011-0000-000000000004', NULL, '00000000-0000-4001-0000-000000000001', 'overtime',        'Overtime',           'أجر إضافي',         'opex', true, 40),
    ('00000000-0000-4011-0000-000000000005', NULL, '00000000-0000-4001-0000-000000000001', 'benefits',        'Benefits',           'مزايا',             'opex', true, 50),

    -- Rent & Facilities subcategories.
    ('00000000-0000-4012-0000-000000000001', NULL, '00000000-0000-4001-0000-000000000002', 'rent',            'Rent',               'إيجار',             'opex', true, 10),
    ('00000000-0000-4012-0000-000000000002', NULL, '00000000-0000-4001-0000-000000000002', 'maintenance',     'Maintenance',        'صيانة',             'opex', true, 20),
    ('00000000-0000-4012-0000-000000000003', NULL, '00000000-0000-4001-0000-000000000002', 'cleaning',        'Cleaning',           'نظافة',             'opex', true, 30),
    ('00000000-0000-4012-0000-000000000004', NULL, '00000000-0000-4001-0000-000000000002', 'security',        'Security',           'أمن',               'opex', true, 40),

    -- Utilities subcategories.
    ('00000000-0000-4013-0000-000000000001', NULL, '00000000-0000-4001-0000-000000000003', 'electricity',     'Electricity',        'كهرباء',            'opex', true, 10),
    ('00000000-0000-4013-0000-000000000002', NULL, '00000000-0000-4001-0000-000000000003', 'water',           'Water',              'مياه',              'opex', true, 20),
    ('00000000-0000-4013-0000-000000000003', NULL, '00000000-0000-4001-0000-000000000003', 'gas',             'Gas',                'غاز',               'opex', true, 30),
    ('00000000-0000-4013-0000-000000000004', NULL, '00000000-0000-4001-0000-000000000003', 'internet',        'Internet',           'إنترنت',            'opex', true, 40),
    ('00000000-0000-4013-0000-000000000005', NULL, '00000000-0000-4001-0000-000000000003', 'telephone',       'Telephone',          'هاتف',              'opex', true, 50),

    -- Marketing subcategories.
    ('00000000-0000-4014-0000-000000000001', NULL, '00000000-0000-4001-0000-000000000004', 'meta_ads',        'Meta Ads',           'إعلانات ميتا',      'opex', true, 10),
    ('00000000-0000-4014-0000-000000000002', NULL, '00000000-0000-4001-0000-000000000004', 'google_ads',      'Google Ads',         'إعلانات جوجل',     'opex', true, 20),
    ('00000000-0000-4014-0000-000000000003', NULL, '00000000-0000-4001-0000-000000000004', 'influencers',     'Influencers',        'مؤثرون',            'opex', true, 30),
    ('00000000-0000-4014-0000-000000000004', NULL, '00000000-0000-4001-0000-000000000004', 'content',         'Content',            'محتوى',             'opex', true, 40),
    ('00000000-0000-4014-0000-000000000005', NULL, '00000000-0000-4001-0000-000000000004', 'printing',        'Printing',           'طباعة',             'opex', true, 50),
    ('00000000-0000-4014-0000-000000000006', NULL, '00000000-0000-4001-0000-000000000004', 'marketing_other', 'Other marketing',    'تسويق أخرى',        'opex', true, 60),

    -- Logistics subcategories.
    ('00000000-0000-4015-0000-000000000001', NULL, '00000000-0000-4001-0000-000000000005', 'delivery',        'Delivery',           'توصيل',             'opex', true, 10),
    ('00000000-0000-4015-0000-000000000002', NULL, '00000000-0000-4001-0000-000000000005', 'shipping',        'Shipping',           'شحن',               'opex', true, 20),
    ('00000000-0000-4015-0000-000000000003', NULL, '00000000-0000-4001-0000-000000000005', 'fuel',            'Fuel',               'وقود',              'opex', true, 30),
    ('00000000-0000-4015-0000-000000000004', NULL, '00000000-0000-4001-0000-000000000005', 'transportation',  'Transportation',     'مواصلات',           'opex', true, 40),

    -- Technology subcategories.
    ('00000000-0000-4016-0000-000000000001', NULL, '00000000-0000-4001-0000-000000000006', 'software',        'Software',           'برمجيات',           'opex', true, 10),
    ('00000000-0000-4016-0000-000000000002', NULL, '00000000-0000-4001-0000-000000000006', 'hosting',         'Hosting',            'استضافة',           'opex', true, 20),
    ('00000000-0000-4016-0000-000000000003', NULL, '00000000-0000-4001-0000-000000000006', 'domains',         'Domains',            'نطاقات',            'opex', true, 30),
    ('00000000-0000-4016-0000-000000000004', NULL, '00000000-0000-4001-0000-000000000006', 'payment_gateway', 'Payment gateway',    'بوابة دفع',         'opex', true, 40),
    ('00000000-0000-4016-0000-000000000005', NULL, '00000000-0000-4001-0000-000000000006', 'sms',             'SMS',                'رسائل نصية',        'opex', true, 50),
    ('00000000-0000-4016-0000-000000000006', NULL, '00000000-0000-4001-0000-000000000006', 'ai_api',          'AI / APIs',          'خدمات ذكاء وAPI',  'opex', true, 60),

    -- Professional subcategories.
    ('00000000-0000-4017-0000-000000000001', NULL, '00000000-0000-4001-0000-000000000007', 'accounting',      'Accounting',         'محاسبة',            'opex', true, 10),
    ('00000000-0000-4017-0000-000000000002', NULL, '00000000-0000-4001-0000-000000000007', 'legal',           'Legal',              'قانونية',           'opex', true, 20),
    ('00000000-0000-4017-0000-000000000003', NULL, '00000000-0000-4001-0000-000000000007', 'consulting',      'Consulting',         'استشارات',          'opex', true, 30),
    ('00000000-0000-4017-0000-000000000004', NULL, '00000000-0000-4001-0000-000000000007', 'licenses',        'Licenses',           'تراخيص',            'opex', true, 40),

    -- Financial subcategories.
    ('00000000-0000-4018-0000-000000000001', NULL, '00000000-0000-4001-0000-000000000008', 'bank_fees',       'Bank fees',          'رسوم بنكية',        'opex', true, 10),
    ('00000000-0000-4018-0000-000000000002', NULL, '00000000-0000-4001-0000-000000000008', 'gateway_fees',    'Gateway fees',       'رسوم بوابة الدفع', 'opex', true, 20),
    ('00000000-0000-4018-0000-000000000003', NULL, '00000000-0000-4001-0000-000000000008', 'interest',        'Interest',           'فوائد',             'opex', true, 30),

    -- Other subcategory.
    ('00000000-0000-4019-0000-000000000001', NULL, '00000000-0000-4001-0000-000000000009', 'miscellaneous',   'Miscellaneous',      'متفرقات',           'opex', true, 10)

ON CONFLICT (slug) WHERE tenant_id IS NULL DO NOTHING;


-- ─── 5. Backfill expenses.category_id from legacy text `category` ───────────
-- The old `category` enum was: rent | salaries | electricity | water | internet
-- | supplier | other. Map each to the corresponding seeded subcategory.
-- 'supplier' is a special case: the legacy value meant "a payment to a
-- supplier"; map to miscellaneous for now since it is not an operating cost
-- category per se — Slice 2's UI can let owners re-classify.

UPDATE "expenses" SET "category_id" = '00000000-0000-4012-0000-000000000001' -- rent
WHERE "category_id" IS NULL AND "category" = 'rent';

UPDATE "expenses" SET "category_id" = '00000000-0000-4011-0000-000000000001' -- salaries
WHERE "category_id" IS NULL AND "category" = 'salaries';

UPDATE "expenses" SET "category_id" = '00000000-0000-4013-0000-000000000001' -- electricity
WHERE "category_id" IS NULL AND "category" = 'electricity';

UPDATE "expenses" SET "category_id" = '00000000-0000-4013-0000-000000000002' -- water
WHERE "category_id" IS NULL AND "category" = 'water';

UPDATE "expenses" SET "category_id" = '00000000-0000-4013-0000-000000000004' -- internet
WHERE "category_id" IS NULL AND "category" = 'internet';

UPDATE "expenses" SET "category_id" = '00000000-0000-4019-0000-000000000001' -- miscellaneous (supplier legacy)
WHERE "category_id" IS NULL AND "category" = 'supplier';

UPDATE "expenses" SET "category_id" = '00000000-0000-4019-0000-000000000001' -- miscellaneous (other)
WHERE "category_id" IS NULL AND ("category" = 'other' OR "category" IS NULL);
