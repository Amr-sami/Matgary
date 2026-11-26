CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"amount" text NOT NULL,
	"category" text NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"returned_quantity" integer NOT NULL,
	"return_date" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" text,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"category_id" uuid NOT NULL,
	"attributes_snapshot" jsonb,
	"brand" text,
	"quantity_sold" integer NOT NULL,
	"price_per_unit" text NOT NULL,
	"cost_price_at_sale" text,
	"subtotal" text NOT NULL,
	"discount_type" text,
	"discount_value" text,
	"discount_amount" text,
	"total_price" text NOT NULL,
	"sale_date" timestamp with time zone DEFAULT now() NOT NULL,
	"is_returned" boolean DEFAULT false NOT NULL,
	"returned_at" timestamp with time zone,
	"returned_quantity" integer,
	"note" text,
	"customer_name" text,
	"customer_phone" text,
	"payment_method" text,
	"is_paid" boolean DEFAULT true NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_tenant_date_idx" ON "expenses" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE INDEX "returns_tenant_date_idx" ON "returns" USING btree ("tenant_id","return_date");--> statement-breakpoint
CREATE INDEX "sales_tenant_date_idx" ON "sales" USING btree ("tenant_id","sale_date");--> statement-breakpoint
CREATE INDEX "sales_tenant_invoice_idx" ON "sales" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "sales_tenant_phone_idx" ON "sales" USING btree ("tenant_id","customer_phone");--> statement-breakpoint
CREATE INDEX "sales_tenant_product_idx" ON "sales" USING btree ("tenant_id","product_id");