import {
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  primaryKey,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Auth.js tables (global) — schema follows @auth/drizzle-adapter conventions
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { mode: "date", withTimezone: true }),
  image: text("image"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// ─────────────────────────────────────────────────────────────────────────────
// Tenancy (global)
// ─────────────────────────────────────────────────────────────────────────────

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    currency: text("currency").notNull().default("EGP"),
    language: text("language").notNull().default("ar"),
    timezone: text("timezone").notNull().default("Africa/Cairo"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
);

export const tenantMembers = pgTable(
  "tenant_members",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index("tenant_members_user_idx").on(t.userId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant settings (scoped) — RLS applied in a separate migration step
// ─────────────────────────────────────────────────────────────────────────────

export const shopSettings = pgTable("shop_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  shopName: text("shop_name").notNull().default(""),
  shopPhone: text("shop_phone"),
  logoPath: text("logo_path"),
  autoOpenWhatsapp: boolean("auto_open_whatsapp").notNull().default(true),
  messageTemplate: text("message_template").notNull().default(""),
  greenApiEnabled: boolean("green_api_enabled").notNull().default(false),
  greenApiInstanceId: text("green_api_instance_id"),
  greenApiToken: text("green_api_token"), // encrypted at rest (Phase 4)
  greenApiUrl: text("green_api_url"),
  sendAsPdf: boolean("send_as_pdf").notNull().default(false),
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// ─────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(tenantMembers),
  sessions: many(sessions),
  accounts: many(accounts),
}));

export const tenantsRelations = relations(tenants, ({ many, one }) => ({
  members: many(tenantMembers),
  settings: one(shopSettings, {
    fields: [tenants.id],
    references: [shopSettings.tenantId],
  }),
}));

export const tenantMembersRelations = relations(tenantMembers, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tenantMembers.tenantId],
    references: [tenants.id],
  }),
  user: one(users, {
    fields: [tenantMembers.userId],
    references: [users.id],
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Catalog (scoped) — categories with optional hierarchical attributes.
// ─────────────────────────────────────────────────────────────────────────────

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    icon: text("icon"), // lucide icon name, falls back to "Package"
    position: integer("position").notNull().default(0),
    hasAttributes: boolean("has_attributes").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("categories_tenant_idx").on(t.tenantId),
    // unique (tenant_id, key) is enforced via a separate index in the SQL migration
  ],
);

export const categoryAttributes = pgTable(
  "category_attributes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // e.g. "gender", "type"
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
    required: boolean("required").notNull().default(true),
  },
  (t) => [index("category_attrs_category_idx").on(t.categoryId)],
);

export const categoryAttributeValues = pgTable(
  "category_attribute_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    attributeId: uuid("attribute_id")
      .notNull()
      .references(() => categoryAttributes.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // e.g. "men", "women"
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("category_attr_values_attr_idx").on(t.attributeId)],
);

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "cascade",
    }), // null = applies to any category
    name: text("name").notNull(),
  },
  (t) => [index("brands_tenant_category_idx").on(t.tenantId, t.categoryId)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    brand: text("brand"),
    quantity: integer("quantity").notNull().default(0),
    price: text("price").notNull(), // stored as numeric in SQL (raw migration tunes it); kept as text in TS for precision
    costPrice: text("cost_price"),
    lowStockThreshold: integer("low_stock_threshold").notNull().default(3),
    sku: text("sku"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    supplier: text("supplier"),
    location: text("location"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("products_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("products_tenant_category_idx").on(t.tenantId, t.categoryId),
    index("products_tenant_sku_idx").on(t.tenantId, t.sku),
  ],
);

// Snapshot of the chosen attribute value for a given product. Stores both the
// value id (for joins) and the value label at create time so historical reports
// stay accurate even if the tenant later renames the value.
export const productAttributeValues = pgTable(
  "product_attribute_values",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    attributeId: uuid("attribute_id")
      .notNull()
      .references(() => categoryAttributes.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => categoryAttributeValues.id, { onDelete: "restrict" }),
    valueLabel: text("value_label").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.productId, t.attributeId] })],
);

export const productHistory = pgTable(
  "product_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    productName: text("product_name").notNull(),
    type: text("type").notNull(), // 'created' | 'updated' | 'restocked' | 'decreased' | 'sold' | 'returned'
    delta: integer("delta"),
    quantityAfter: integer("quantity_after"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("product_history_tenant_product_idx").on(t.tenantId, t.productId)],
);

// Catalog relations
export const categoriesRelations = relations(categories, ({ many, one }) => ({
  attributes: many(categoryAttributes),
  products: many(products),
  brands: many(brands),
  tenant: one(tenants, { fields: [categories.tenantId], references: [tenants.id] }),
}));

export const categoryAttributesRelations = relations(
  categoryAttributes,
  ({ many, one }) => ({
    values: many(categoryAttributeValues),
    category: one(categories, {
      fields: [categoryAttributes.categoryId],
      references: [categories.id],
    }),
  }),
);

export const productsRelations = relations(products, ({ many, one }) => ({
  attributeValues: many(productAttributeValues),
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Operations (scoped) — sales / returns / expenses.
// ─────────────────────────────────────────────────────────────────────────────

import { jsonb } from "drizzle-orm/pg-core";

export const sales = pgTable(
  "sales",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id"),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    productName: text("product_name").notNull(), // snapshot
    categoryId: uuid("category_id").notNull(), // snapshot
    /** Snapshot of attribute labels at sale time (e.g. { gender: "رجالي" }). */
    attributesSnapshot: jsonb("attributes_snapshot").$type<Record<string, string>>(),
    brand: text("brand"), // snapshot
    quantitySold: integer("quantity_sold").notNull(),
    pricePerUnit: text("price_per_unit").notNull(), // numeric in SQL via migration tune
    costPriceAtSale: text("cost_price_at_sale"),
    subtotal: text("subtotal").notNull(),
    discountType: text("discount_type"), // 'percentage' | 'fixed' | null
    discountValue: text("discount_value"),
    discountAmount: text("discount_amount"),
    totalPrice: text("total_price").notNull(),
    saleDate: timestamp("sale_date", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    isReturned: boolean("is_returned").notNull().default(false),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    returnedQuantity: integer("returned_quantity"),
    note: text("note"),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"), // normalized
    paymentMethod: text("payment_method"), // 'cash' | 'instapay' | 'card' | 'deferred'
    isPaid: boolean("is_paid").notNull().default(true),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => [
    index("sales_tenant_date_idx").on(t.tenantId, t.saleDate),
    index("sales_tenant_invoice_idx").on(t.tenantId, t.invoiceId),
    index("sales_tenant_phone_idx").on(t.tenantId, t.customerPhone),
    index("sales_tenant_product_idx").on(t.tenantId, t.productId),
  ],
);

export const returns = pgTable(
  "returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    productName: text("product_name").notNull(),
    returnedQuantity: integer("returned_quantity").notNull(),
    returnDate: timestamp("return_date", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    reason: text("reason"),
  },
  (t) => [index("returns_tenant_date_idx").on(t.tenantId, t.returnDate)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    amount: text("amount").notNull(), // numeric via migration tune
    category: text("category").notNull(), // global enum: rent | salaries | electricity | water | internet | other
    date: timestamp("date", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    note: text("note"),
  },
  (t) => [index("expenses_tenant_date_idx").on(t.tenantId, t.date)],
);

// Convenience type exports for the rest of the app
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantMember = typeof tenantMembers.$inferSelect;
export type ShopSettingsRow = typeof shopSettings.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type CategoryAttributeRow = typeof categoryAttributes.$inferSelect;
export type CategoryAttributeValueRow = typeof categoryAttributeValues.$inferSelect;
export type BrandRow = typeof brands.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type ProductAttributeValueRow = typeof productAttributeValues.$inferSelect;
export type SaleRow = typeof sales.$inferSelect;
export type ReturnRow = typeof returns.$inferSelect;
export type ExpenseRow = typeof expenses.$inferSelect;
