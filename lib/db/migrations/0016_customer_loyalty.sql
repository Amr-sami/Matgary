-- Customer loyalty + store credit. One unified wallet per (tenant, branch,
-- customer phone) holding both points and an EGP credit balance, plus an
-- append-only event log so every change has a trail.
--
-- Multi-store: scoped to (tenant, branch). Each branch runs its own
-- programme — customer's points at "main" don't apply at "cairo".
-- Matches the rest of the multi-store isolation model.
--
-- Points vs credit: kept on one row but they're conceptually distinct.
-- Points accumulate from purchases at a configurable rate; credit is
-- granted explicitly (refunds, gift cards, complaint resolution).
-- Either can be applied at checkout to discount a sale.

CREATE TABLE "customer_wallets" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  -- Customer key — same canonical +20… form the rest of the app stores.
  "customer_phone" text NOT NULL,
  -- Snapshot of the latest seen name; useful for the wallet UI when the
  -- customer hasn't been on a recent sale row.
  "customer_name" text,
  -- Points balance. Integer because most loyalty schemes round to whole
  -- points (a "0.5 point" earns no goodwill).
  "points" integer NOT NULL DEFAULT 0,
  -- EGP credit balance. Numeric because it's currency.
  "credit" numeric(14, 2) NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "branch_id", "customer_phone")
);
--> statement-breakpoint

CREATE INDEX "customer_wallets_tenant_branch_idx"
  ON "customer_wallets" ("tenant_id", "branch_id");
--> statement-breakpoint

ALTER TABLE "customer_wallets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_wallets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_wallets_tenant_isolation" ON "customer_wallets"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Append-only event log. Every wallet change writes a row. Negative
-- deltas for redemptions; positive for earns / grants. The (sale_id /
-- return_id / actor_user_id) fields make every event traceable to its
-- source.
CREATE TABLE "customer_wallet_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "customer_phone" text NOT NULL,
  -- 'points_earn' | 'points_redeem' | 'points_expire'
  -- 'credit_grant' | 'credit_redeem' | 'credit_refund'
  -- 'credit_deduct' (manual owner adjustment downward)
  "kind" text NOT NULL,
  -- Signed delta on each balance. Most events touch only one of them but
  -- a future "convert points → credit" feature could touch both.
  "points_delta" integer NOT NULL DEFAULT 0,
  "credit_delta" numeric(14, 2) NOT NULL DEFAULT 0,
  -- Source pointers — null when not tied to a specific row.
  "related_sale_id" uuid REFERENCES "sales"("id") ON DELETE SET NULL,
  "related_return_id" uuid REFERENCES "returns"("id") ON DELETE SET NULL,
  -- Whoever initiated the change (cashier, owner, system). Null for
  -- system-driven events like points_expire.
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- Free-form note for manual grants/deductions. The UI surfaces this in
  -- the event history so the owner can answer "why did Ahmed get 50 EGP?".
  "reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX "customer_wallet_events_lookup_idx"
  ON "customer_wallet_events" ("tenant_id", "branch_id", "customer_phone", "created_at");
--> statement-breakpoint
CREATE INDEX "customer_wallet_events_sale_idx"
  ON "customer_wallet_events" ("related_sale_id");
--> statement-breakpoint

ALTER TABLE "customer_wallet_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_wallet_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_wallet_events_tenant_isolation" ON "customer_wallet_events"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Loyalty config lives on shop_settings (per-branch). Disabled by
-- default; owner enables in the settings page and sets the rates.
ALTER TABLE "shop_settings"
  ADD COLUMN "loyalty_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Earn rate: how many points one EGP earns. e.g. `0.1` = 1 point per
-- 10 EGP, `1` = 1 point per EGP. Numeric so fractional rates are
-- expressible; the application floors the awarded points to an int.
ALTER TABLE "shop_settings"
  ADD COLUMN "loyalty_points_per_egp" numeric(8, 4) NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Redeem rate: EGP value of one point. e.g. `0.1` = 1 point = 0.10 EGP off.
-- Cashier enters "redeem N points" → discount = N * this rate.
ALTER TABLE "shop_settings"
  ADD COLUMN "loyalty_egp_per_point" numeric(8, 4) NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Optional expiry window for earned points. Null = never expire. A
-- future cron walks customer_wallet_events.kind='points_earn' looking
-- for entries older than this many days and writes 'points_expire'
-- offsets — not part of this MVP, but the schema supports it.
ALTER TABLE "shop_settings"
  ADD COLUMN "loyalty_expiry_days" integer;
