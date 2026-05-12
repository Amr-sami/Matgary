import {
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  primaryKey,
  integer,
  index,
  jsonb,
  uniqueIndex,
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
  /** When true, login succeeds but every page redirects to /account/change-password. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
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
    role: text("role").notNull().default("owner"), // 'owner' | 'staff'
    /** Permission keys (see lib/permissions.ts). Owner ignores this — has all. */
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    /** Display name for sub-accounts (e.g. "Ahmed"). For owner this duplicates users.name. */
    displayName: text("display_name"),
    /** Multi-store: each staff member is locked to ONE branch. NULL only for
     *  the owner role (implicit access to every branch — they pick via the
     *  topbar picker). The legacy uuid[] `branch_ids` column is kept for one
     *  more deploy in case anything still reads it; will be dropped in a
     *  follow-up. */
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "restrict",
    }),
    /** @deprecated read `branchId` instead. Kept only for back-compat. */
    branchIds: uuid("branch_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** Contact phone (free-form, normalized at the form level). */
    phone: text("phone"),
    /** Egyptian national ID (or other government ID). */
    nationalId: text("national_id"),
    /** Free-form address. */
    address: text("address"),
    /** Relative path under uploads/ (e.g. "<tenantId>/<uuid>.jpg") — served via /api/uploads/team. */
    profilePhotoPath: text("profile_photo_path"),
    idPhotoPath: text("id_photo_path"),
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
// Branches (scoped) — multi-location support. Every tenant has at least one
// branch (its primary). Sales / inventory / attendance / purchases all carry
// a branch_id so reports and stock can be sliced per location.
// ─────────────────────────────────────────────────────────────────────────────

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Stable URL-safe identifier within the tenant. "main" for the primary
     *  branch; auto-derived from name + random suffix for additional ones. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Free-form physical address line. */
    address: text("address"),
    /** Branch-specific contact phone (mobile or landline). */
    phone: text("phone"),
    /** Soft-disable flag: hides from selectors but preserves history. */
    isActive: boolean("is_active").notNull().default(true),
    /** Tenant's primary branch. Created automatically on signup. Protected
     *  from deletion. Exactly one per tenant (enforced by partial unique
     *  index in the migration). */
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("branches_tenant_idx").on(t.tenantId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant settings (scoped) — RLS applied in a separate migration step
// ─────────────────────────────────────────────────────────────────────────────

// shop_settings is now per-(tenant, branch). Each branch has its own shop
// name, logo, WhatsApp credentials, and message template — full multi-store
// isolation. The composite primary key replaces the old tenant-only PK.
export const shopSettings = pgTable(
  "shop_settings",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    shopName: text("shop_name").notNull().default(""),
    shopPhone: text("shop_phone"),
    logoPath: text("logo_path"),
    autoOpenWhatsapp: boolean("auto_open_whatsapp").notNull().default(true),
    messageTemplate: text("message_template").notNull().default(""),
    greenApiEnabled: boolean("green_api_enabled").notNull().default(false),
    greenApiInstanceId: text("green_api_instance_id"),
    greenApiToken: text("green_api_token"), // encrypted at rest (Phase 4)
    greenApiUrl: text("green_api_url"),
    // Meta's official WhatsApp Business Cloud API. Sits alongside Green API;
    // when both are configured the application prefers this one. Token is
    // encrypted at rest with the same lib/crypto scheme as greenApiToken.
    whatsappCloudEnabled: boolean("whatsapp_cloud_enabled").notNull().default(false),
    whatsappCloudPhoneId: text("whatsapp_cloud_phone_id"),
    whatsappCloudToken: text("whatsapp_cloud_token"),
    whatsappCloudBusinessId: text("whatsapp_cloud_business_id"),
    sendAsPdf: boolean("send_as_pdf").notNull().default(false),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    /** Loyalty programme — disabled by default. Each branch runs its own. */
    loyaltyEnabled: boolean("loyalty_enabled").notNull().default(false),
    /** How many points one EGP earns. e.g. 0.1 = 1 pt per 10 EGP. Numeric;
     *  the application floors awarded points to int. Stored as text in TS. */
    loyaltyPointsPerEgp: text("loyalty_points_per_egp").notNull().default("0"),
    /** EGP value of one point. e.g. 0.1 = 1 pt = 0.10 EGP off. */
    loyaltyEgpPerPoint: text("loyalty_egp_per_point").notNull().default("0"),
    /** Optional expiry window for earned points. Null = never expire. */
    loyaltyExpiryDays: integer("loyalty_expiry_days"),
    /** Receipt customisation — see migration 0017. */
    receiptLogoSize: text("receipt_logo_size").notNull().default("medium"),
    receiptFooterText: text("receipt_footer_text").notNull().default(""),
    receiptLanguage: text("receipt_language").notNull().default("ar"),
    receiptShowLoyalty: boolean("receipt_show_loyalty").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.branchId] })],
);

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
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
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
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // e.g. "gender", "type"
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
    required: boolean("required").notNull().default(true),
  },
  (t) => [
    index("category_attrs_category_idx").on(t.categoryId),
    index("category_attrs_branch_idx").on(t.branchId),
  ],
);

export const categoryAttributeValues = pgTable(
  "category_attribute_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    attributeId: uuid("attribute_id")
      .notNull()
      .references(() => categoryAttributes.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // e.g. "men", "women"
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("category_attr_values_attr_idx").on(t.attributeId),
    index("category_attr_values_branch_idx").on(t.branchId),
  ],
);

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "cascade",
    }), // null = applies to any category
    name: text("name").notNull(),
  },
  (t) => [
    index("brands_tenant_category_idx").on(t.tenantId, t.categoryId),
    index("brands_branch_idx").on(t.branchId),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Each product belongs to exactly one branch — the multi-store model.
     *  Migrating between branches means duplicating the row; sales / history
     *  references stay on the original product id. */
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    brand: text("brand"),
    /** On-hand quantity at this product's branch. */
    quantity: integer("quantity").notNull().default(0),
    price: text("price").notNull(), // stored as numeric in SQL (raw migration tunes it); kept as text in TS for precision
    costPrice: text("cost_price"),
    lowStockThreshold: integer("low_stock_threshold").notNull().default(3),
    sku: text("sku"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    supplier: text("supplier"),
    /** Linked supplier record. Coexists with the legacy `supplier` text column. */
    supplierId: uuid("supplier_id"),
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
    index("products_tenant_supplier_idx").on(t.tenantId, t.supplierId),
  ],
);

// `product_stock` was the chain-store-era per-(product, branch) inventory
// table. Multi-store killed it: products now belong to one branch and carry
// their own `quantity`. Migration 0015 dropped the table + its trigger.

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
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
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


export const sales = pgTable(
  "sales",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Branch the sale was rung up at. Nullable during the multi-branch
     *  rollout so legacy code paths and existing writers don't break; the
     *  migration backfills every historical row to the tenant's primary
     *  branch. A follow-up migration will tighten to NOT NULL once every
     *  writer plumbs the active-branch context. */
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "restrict",
    }),
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
    /** The user (cashier or owner) who recorded this sale. Null on legacy rows. */
    recordedByUserId: uuid("recorded_by_user_id"),
  },
  (t) => [
    index("sales_tenant_date_idx").on(t.tenantId, t.saleDate),
    index("sales_tenant_invoice_idx").on(t.tenantId, t.invoiceId),
    index("sales_tenant_phone_idx").on(t.tenantId, t.customerPhone),
    index("sales_tenant_product_idx").on(t.tenantId, t.productId),
    index("sales_tenant_recorded_by_idx").on(t.tenantId, t.recordedByUserId),
    index("sales_tenant_branch_date_idx").on(t.tenantId, t.branchId, t.saleDate),
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
    /** Branch this expense was incurred at. Nullable: a tenant-wide cost
     *  (e.g. SaaS subscription, accounting fees) leaves it null. */
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "restrict",
    }),
    title: text("title").notNull(),
    amount: text("amount").notNull(), // numeric via migration tune
    category: text("category").notNull(), // global enum: rent | salaries | electricity | water | internet | supplier | other
    /** Optional supplier this expense pays. When set, the supplier's running balance is debited. */
    supplierId: uuid("supplier_id"),
    /** When true, this expense is a recurring template; child instances spawn at next_occurrence_date. */
    isRecurring: boolean("is_recurring").notNull().default(false),
    /** 'monthly' | 'weekly' — only meaningful when is_recurring=true. */
    recurrencePeriod: text("recurrence_period"),
    /** Next time this template should spawn a child instance (null when not recurring or done). */
    nextOccurrenceDate: timestamp("next_occurrence_date", { withTimezone: true }),
    /** Set on auto-generated child instances; points back at the recurring template. */
    parentExpenseId: uuid("parent_expense_id"),
    date: timestamp("date", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    note: text("note"),
  },
  (t) => [
    index("expenses_tenant_date_idx").on(t.tenantId, t.date),
    index("expenses_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    index("expenses_tenant_recurring_idx").on(t.tenantId, t.isRecurring, t.nextOccurrenceDate),
    index("expenses_tenant_branch_date_idx").on(t.tenantId, t.branchId, t.date),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Suppliers & Purchase Orders (scoped) — RLS applied in a separate migration step
// ─────────────────────────────────────────────────────────────────────────────

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    notes: text("notes"),
    /** Running amount owed to this supplier (POs received minus payments). Stored as numeric in SQL. */
    balance: text("balance").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("suppliers_tenant_idx").on(t.tenantId),
    index("suppliers_branch_idx").on(t.branchId),
  ],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Branch the goods are received into. Nullable during the multi-branch
     *  rollout (see sales.branchId for the same rollout pattern); migration
     *  backfills, follow-up migration tightens to NOT NULL. */
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "restrict",
    }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    /** 'draft' | 'received' | 'cancelled'. Receiving bumps stock and supplier balance atomically. */
    status: text("status").notNull().default("draft"),
    orderDate: timestamp("order_date", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    receivedDate: timestamp("received_date", { withTimezone: true }),
    notes: text("notes"),
    total: text("total").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("purchase_orders_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    index("purchase_orders_tenant_date_idx").on(t.tenantId, t.orderDate),
    index("purchase_orders_tenant_branch_date_idx").on(t.tenantId, t.branchId, t.orderDate),
  ],
);

export const purchaseOrderItems = pgTable(
  "purchase_order_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    /** Null = ad-hoc item not tied to an existing product (won't bump stock on receive). */
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    productName: text("product_name").notNull(),
    quantity: integer("quantity").notNull(),
    unitCost: text("unit_cost").notNull(),
    lineTotal: text("line_total").notNull(),
  },
  (t) => [
    index("po_items_tenant_po_idx").on(t.tenantId, t.purchaseOrderId),
  ],
);

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  purchaseOrders: many(purchaseOrders),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ many, one }) => ({
  items: many(purchaseOrderItems),
  supplier: one(suppliers, {
    fields: [purchaseOrders.supplierId],
    references: [suppliers.id],
  }),
}));

export const purchaseOrderItemsRelations = relations(purchaseOrderItems, ({ one }) => ({
  purchaseOrder: one(purchaseOrders, {
    fields: [purchaseOrderItems.purchaseOrderId],
    references: [purchaseOrders.id],
  }),
  product: one(products, {
    fields: [purchaseOrderItems.productId],
    references: [products.id],
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Attendance & payroll (scoped) — RLS applied in a separate migration step
// ─────────────────────────────────────────────────────────────────────────────

export const attendanceSettings = pgTable("attendance_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** Configured working hours per day. Anything beyond this in a single day counts as overtime. */
  workHoursPerDay: text("work_hours_per_day").notNull().default("8"),
  /** ISO weekday numbers (1=Mon … 7=Sun). Default {5,6} = Fri+Sat. */
  weekendDays: integer("weekend_days").array().notNull().default(sql`'{5,6}'::int[]`),
  /** Multiplier applied to hourly rate for overtime hours (e.g. 1.5). */
  overtimeMultiplier: text("overtime_multiplier").notNull().default("1.0"),
  /** Minutes of grace before a check-in counts as late. */
  graceMinutesLate: integer("grace_minutes_late").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const storeLocations = pgTable(
  "store_locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Branch this geofence pin belongs to. A branch may have several pins
     *  (front + back entry, etc.). Nullable for backwards compatibility with
     *  pre-multi-branch rows; the backfill points each pin at the tenant's
     *  primary branch. */
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    latitude: text("latitude").notNull(), // numeric(9,6) via migration tune
    longitude: text("longitude").notNull(), // numeric(9,6) via migration tune
    geofenceRadiusM: integer("geofence_radius_m").notNull().default(50),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("store_locations_tenant_idx").on(t.tenantId),
    index("store_locations_branch_idx").on(t.branchId),
  ],
);

export const attendanceEvents = pgTable(
  "attendance_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Branch the employee clocked in/out at. Nullable during the
     *  multi-branch rollout; migration backfills, follow-up tightens. */
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "restrict",
    }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 'check_in' | 'check_out' */
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** 'manual' | 'geofence' | 'qr' | 'manager_attest' */
    source: text("source").notNull(),
    latitude: text("latitude"),
    longitude: text("longitude"),
    accuracyM: integer("accuracy_m"),
    /** Whoever inserted the row. Same as employeeId for self-records. */
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    note: text("note"),
    /** Set true when an open check_in was followed by another check_in (forgot to check out). Manager must reconcile. */
    requiresReview: boolean("requires_review").notNull().default(false),
  },
  (t) => [
    index("attendance_tenant_employee_time_idx").on(
      t.tenantId,
      t.employeeId,
      t.occurredAt,
    ),
    index("attendance_tenant_time_idx").on(t.tenantId, t.occurredAt),
    index("attendance_tenant_branch_time_idx").on(t.tenantId, t.branchId, t.occurredAt),
  ],
);

export const employeeCompensation = pgTable(
  "employee_compensation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 'fixed' | 'hourly' | 'hybrid' */
    payType: text("pay_type").notNull(),
    baseSalaryMonthly: text("base_salary_monthly"), // numeric(12,2) via migration tune
    hourlyRate: text("hourly_rate"), // numeric(12,2) via migration tune
    /** Hours included in the base monthly salary (hybrid only). Beyond this counts as overtime. */
    standardMonthlyHours: text("standard_monthly_hours"),
    /** Date the row becomes effective. Lookups use the row whose effective_from ≤ shift date. */
    effectiveFrom: timestamp("effective_from", { mode: "date", withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("emp_comp_tenant_employee_effective_idx").on(
      t.tenantId,
      t.employeeId,
      t.effectiveFrom,
    ),
  ],
);

export const payrollPeriods = pgTable(
  "payroll_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { mode: "date", withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { mode: "date", withTimezone: true }).notNull(),
    regularHours: text("regular_hours").notNull().default("0"),
    overtimeHours: text("overtime_hours").notNull().default("0"),
    grossAmount: text("gross_amount").notNull().default("0"),
    adjustmentsAmount: text("adjustments_amount").notNull().default("0"),
    adjustmentsNote: text("adjustments_note"),
    /** 'draft' | 'finalized' */
    status: text("status").notNull().default("draft"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedByUserId: uuid("finalized_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    index("payroll_periods_tenant_employee_period_idx").on(
      t.tenantId,
      t.employeeId,
      t.periodStart,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — tasks, leave requests, notifications (scoped) — RLS in migration
// ─────────────────────────────────────────────────────────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    /** The doer; null = unassigned (rare). */
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Manager / owner who created the task. */
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"),
    /** 'open' | 'in_progress' | 'done' | 'cancelled' */
    status: text("status").notNull().default("open"),
    /** 'low' | 'normal' | 'high' */
    priority: text("priority").notNull().default("normal"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Set when the assignee opens the tab; null = unread. Reset on manager edits. */
    assigneeSeenAt: timestamp("assignee_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("tasks_tenant_assignee_idx").on(t.tenantId, t.assignedToUserId),
    index("tasks_tenant_status_idx").on(t.tenantId, t.status),
    index("tasks_branch_idx").on(t.branchId),
  ],
);

export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    reason: text("reason"),
    /** 'pending' | 'approved' | 'rejected' */
    status: text("status").notNull().default("pending"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("leave_requests_tenant_user_idx").on(t.tenantId, t.userId),
    index("leave_requests_tenant_status_idx").on(t.tenantId, t.status),
    index("leave_requests_branch_idx").on(t.branchId),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Branch context for the notification. Nullable: tenant-wide system
     *  notifications (e.g. billing) leave it null. */
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    /** Recipient. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Loose enum: 'low_stock' | 'task_assigned' | 'task_done' | 'leave_submitted' | 'leave_decided' | ... */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /** App-relative URL to drill into. */
    link: text("link"),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("notifications_tenant_user_idx").on(t.tenantId, t.userId, t.createdAt),
    index("notifications_tenant_user_unread_idx").on(t.tenantId, t.userId, t.isRead),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// SaaS billing — subscriptions + payment attempts (scoped, RLS in migration)
// ─────────────────────────────────────────────────────────────────────────────

export const subscriptions = pgTable("subscriptions", {
  /** 1:1 with tenant — the tenant owns at most one active subscription. */
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /**
   * Plan key. We start with two plans + the trial sentinel:
   *  - 'trial'        — fresh signup, 14-day full access
   *  - 'professional' — single store, full feature set, paid monthly
   *  - 'multi_branch' — placeholder; gated behind future multi-branch work
   */
  plan: text("plan").notNull().default("trial"),
  /**
   * Lifecycle:
   *  - 'trialing'   — inside the 14-day window
   *  - 'active'     — paid + within current period
   *  - 'past_due'   — payment failed; inside the 7-day grace
   *  - 'cancelled'  — owner cancelled; access until current_period_ends_at
   *  - 'expired'    — trial elapsed without payment, or grace exhausted
   */
  status: text("status").notNull().default("trialing"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }).notNull(),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEndsAt: timestamp("current_period_ends_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  /** Monthly price for this plan in EGP, snapshot at subscribe time. */
  amountEgp: text("amount_egp"),
  /** Paymob bookkeeping. */
  paymobCustomerId: text("paymob_customer_id"),
  /** Last successful Paymob order id; written by the webhook on success. */
  paymobLastOrderId: text("paymob_last_order_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Paymob order id we registered before sending the user to the iframe. */
    paymobOrderId: text("paymob_order_id"),
    /** Paymob transaction id (callbacks). Used as the idempotency key. */
    paymobTransactionId: text("paymob_transaction_id"),
    amountEgp: text("amount_egp").notNull(),
    /**
     * 'pending' once the order is registered, then 'succeeded' / 'failed' on
     * webhook. We never delete rows — payment history is the timeline.
     */
    status: text("status").notNull().default("pending"),
    failureReason: text("failure_reason"),
    /** Raw HMAC-verified webhook payload. Useful for support + post-mortem. */
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    index("payment_attempts_tenant_attempted_idx").on(t.tenantId, t.attemptedAt),
    // Idempotency: Paymob may deliver a webhook twice. The unique txn id keeps
    // us honest at the DB level even if the application's idempotency check fails.
    index("payment_attempts_paymob_txn_idx").on(t.paymobTransactionId),
  ],
);

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Customer loyalty + store credit. One unified wallet per (tenant, branch,
// customer phone). Multi-store: each branch runs its own programme — points
// at "main" don't apply at "cairo".
// ─────────────────────────────────────────────────────────────────────────────

export const customerWallets = pgTable(
  "customer_wallets",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    /** Canonical +20… form, same as `sales.customer_phone`. */
    customerPhone: text("customer_phone").notNull(),
    /** Snapshot of the latest seen name. UI fallback when no recent sale row. */
    customerName: text("customer_name"),
    /** Loyalty points balance — integer (most schemes round to whole points). */
    points: integer("points").notNull().default(0),
    /** EGP credit balance. Stored as numeric in SQL (precision-preserving). */
    credit: text("credit").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.branchId, t.customerPhone] }),
    index("customer_wallets_tenant_branch_idx").on(t.tenantId, t.branchId),
  ],
);

export const customerWalletEvents = pgTable(
  "customer_wallet_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    customerPhone: text("customer_phone").notNull(),
    /** 'points_earn' | 'points_redeem' | 'points_expire' |
     *  'credit_grant' | 'credit_redeem' | 'credit_refund' | 'credit_deduct' */
    kind: text("kind").notNull(),
    pointsDelta: integer("points_delta").notNull().default(0),
    /** Numeric in SQL — text in TS for precision. */
    creditDelta: text("credit_delta").notNull().default("0"),
    relatedSaleId: uuid("related_sale_id").references(() => sales.id, {
      onDelete: "set null",
    }),
    relatedReturnId: uuid("related_return_id").references(() => returns.id, {
      onDelete: "set null",
    }),
    /** Whoever initiated the change. Null for system events (e.g. expiry cron). */
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Free-form note for manual grants/deductions. */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("customer_wallet_events_lookup_idx").on(
      t.tenantId,
      t.branchId,
      t.customerPhone,
      t.createdAt,
    ),
    index("customer_wallet_events_sale_idx").on(t.relatedSaleId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Audit / activity log (scoped) — RLS applied in a separate migration step.
// One row per non-trivial mutation in the app. Insertion is fire-and-forget
// from logActivity() — failures are swallowed so they never break the parent
// mutation.
// ─────────────────────────────────────────────────────────────────────────────

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Whoever performed the action. Nullable so we can keep history if the user is deleted. */
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Snapshot of the actor's display name at the time, so the log stays readable after deletes/renames. */
    actorName: text("actor_name"),
    /** Namespaced identifier, e.g. "team.add", "settings.update", "auth.login". */
    action: text("action").notNull(),
    /** Coarse bucket for filtering: 'team' | 'product' | 'sale' | 'expense' | 'settings' | 'auth' | ... */
    category: text("category").notNull(),
    /** Optional resource type, e.g. "user", "product", "sale". Used to deep-link from a row. */
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    /** Snapshot of a human label for the entity (e.g. product name, employee display name). */
    entityLabel: text("entity_label"),
    /** Free-form extras: { before: {...}, after: {...} } for updates, key fields for creates. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ip: text("ip"),
    /** Branch the action happened at, when applicable. Nullable: tenant-wide
     *  actions (e.g. settings change) leave it null. Pure context — never a
     *  gate. */
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("activity_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("activity_logs_tenant_actor_idx").on(t.tenantId, t.actorUserId),
    index("activity_logs_tenant_category_idx").on(t.tenantId, t.category),
  ],
);

export type ActivityLogRow = typeof activityLogs.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Cloud API connections (provider-agnostic shape so we can later add
// SMS fallback providers, Twilio, etc. without another schema migration).
//
// Each row = one (tenant, branch, phone_number_id) binding. The Embedded
// Signup OAuth flow writes here; manual fields on shop_settings stay as the
// fallback for tenants that haven't been onboarded through App Review yet.
// Webhook events route to a tenant by phone_number_id — that's why this
// table is NOT scoped by current_setting('app.tenant_id') at the WHERE
// level on inserts; we use raw db + an explicit tenant_id column with RLS
// USING/WITH CHECK still in place.
// ─────────────────────────────────────────────────────────────────────────────

export const waConnections = pgTable(
  "wa_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),

    // Provider identity. 'meta_cloud' today; 'twilio' / 'sms_*' later.
    provider: text("provider").notNull().default("meta_cloud"),

    // Meta identifiers (canonical for routing webhooks → tenant).
    wabaId: text("waba_id").notNull(),
    phoneNumberId: text("phone_number_id").notNull(),
    businessId: text("business_id"),
    displayPhoneNumber: text("display_phone_number"),
    verifiedName: text("verified_name"),

    // Credentials. Token is always encrypted at rest via lib/crypto.
    // tokenType: 'user' (short-lived OAuth code exchange),
    //            'long_lived' (60d, refreshable),
    //            'system_user' (non-expiring, from BSP path).
    accessToken: text("access_token").notNull(),
    tokenType: text("token_type").notNull().default("long_lived"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: text("scopes"),

    // Lifecycle. status: 'active' | 'disconnected' | 'expired' | 'revoked' | 'error'
    status: text("status").notNull().default("active"),
    // mode: 'sandbox' (test number) | 'live' (post business verification)
    mode: text("mode").notNull().default("sandbox"),
    webhookSubscribed: boolean("webhook_subscribed").notNull().default(false),

    // Audit / debugging trail. raw_metadata holds the latest Graph response
    // for the WABA + phone lookup so we can diagnose token-scope issues
    // without re-running the OAuth flow.
    connectedByUserId: uuid("connected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Webhook routing: phone_number_id is globally unique on Meta's side,
    // so we enforce that here too. If a number moves between tenants we
    // delete-then-insert (the old connection is marked disconnected first).
    uniqueIndex("wa_connections_phone_number_id_uniq").on(t.phoneNumberId),
    index("wa_connections_tenant_idx").on(t.tenantId),
    index("wa_connections_branch_idx").on(t.tenantId, t.branchId),
    index("wa_connections_waba_idx").on(t.wabaId),
    index("wa_connections_status_idx").on(t.status),
  ],
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
export type AttendanceSettingsRow = typeof attendanceSettings.$inferSelect;
export type StoreLocationRow = typeof storeLocations.$inferSelect;
export type AttendanceEventRow = typeof attendanceEvents.$inferSelect;
export type EmployeeCompensationRow = typeof employeeCompensation.$inferSelect;
export type WaConnectionRow = typeof waConnections.$inferSelect;
export type NewWaConnection = typeof waConnections.$inferInsert;
export type PayrollPeriodRow = typeof payrollPeriods.$inferSelect;
