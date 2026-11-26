import {
  pgTable,
  text,
  uuid,
  timestamp,
  time,
  boolean,
  primaryKey,
  integer,
  index,
  jsonb,
  uniqueIndex,
  check,
  numeric,
  smallint,
  date,
  doublePrecision,
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
  /** Base32-encoded TOTP shared secret. Set during enrollment, null when 2FA is off. */
  totpSecret: text("totp_secret"),
  /** Non-null marks 2FA active. Login requires a TOTP / recovery code on top of the password. */
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  /** bcrypt-hashed recovery codes. Each is consumed (removed) on use. */
  recoveryCodesHash: text("recovery_codes_hash").array(),
  /** Bumped on password change, 2FA enable/disable, and explicit "sign out
   *  everywhere". JWTs carry the value at issue; session callback rejects
   *  tokens whose `tv` claim no longer matches. */
  tokenVersion: integer("token_version").notNull().default(0),
  /** Preferred UI language. Set at signup from the locale prefix of the
   *  signup URL; used by the password-reset email to pick a template and
   *  link locale so users see the email in the language they chose.
   *  CHECK-constrained to ('ar', 'en') at the DB level (migration 0031). */
  locale: text("locale").notNull().default("ar"),
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

/**
 * Native-client refresh tokens, one row per device (migrations 0046, 0052).
 *
 * Auth bootstrap like `users` / `sessions`: read before a tenant context
 * exists, so it carries no RLS policy and every query filters on user_id.
 * The routes under app/api/v1/auth/** still speak raw SQL to it; this
 * definition documents the columns and types the RETURNING rows. `tenants`
 * is declared further down — the lazy `references` callback is fine with it.
 */
export const authDevices = pgTable(
  "auth_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the refresh token. The plaintext is never stored. */
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    deviceName: text("device_name"),
    platform: text("platform"),
    appVersion: text("app_version"),
    installId: text("install_id"),
    /** Rotation lineage: the successor row minted by /auth/refresh. */
    replacedById: uuid("replaced_by_id"),
    /**
     * users.token_version this session was issued under. Written at login,
     * carried forward on rotation, compared against the live value on every
     * refresh — the server-held baseline for "sign out everywhere", so a
     * device refreshing without a bearer can no longer slip past the sweep.
     */
    tokenVersion: integer("token_version").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  // Byte-for-byte what migration 0046 created. The unique partial index is
  // load-bearing: the login upsert (lib/api/native-session.ts) and the
  // per-device revoke both rely on "one live row per (user, install)". A
  // declaration that omitted it would make the next `drizzle-kit generate`
  // emit its DROP.
  (t) => [
    index("auth_devices_user_idx").on(t.userId).where(sql`revoked_at IS NULL`),
    index("auth_devices_user_created_idx").on(t.userId, t.createdAt.desc()),
    uniqueIndex("auth_devices_user_install_live_idx")
      .on(t.userId, t.installId)
      .where(sql`revoked_at IS NULL AND install_id IS NOT NULL`),
    index("auth_devices_expiry_idx").on(t.expiresAt).where(sql`revoked_at IS NULL`),
  ],
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
    /** H12 — non-null marks the tenant scheduled for hard deletion. Login
     *  + middleware show a banner with the countdown; the cron sidecar
     *  enforces the cutoff. */
    deletionScheduledAt: timestamp("deletion_scheduled_at", { withTimezone: true }),
    /** Platform admin Spec 03 — non-null = tenant is suspended, all user
     *  requests get bounced to /service-paused. */
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendedReason: text("suspended_reason"),
    /** Demo store — true on the seeded template AND on every visitor's clone. */
    isDemo: boolean("is_demo").notNull().default(false),
    /** Demo store — NULL on the template; set to the template's id on clones.
     *  Cleanup cron deletes clones (not the template) older than the idle TTL. */
    demoTemplateId: uuid("demo_template_id"),
    /** Demo store — bumped on each demo request; cleanup uses it as idle clock. */
    demoLastActiveAt: timestamp("demo_last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
);

/** H12 — gravestone for deleted tenants. NOT scoped via tenant_id RLS
 *  (the tenant is gone by the time we read this) and intentionally
 *  outlives the tenants row so dispute resolution + audit are possible. */
export const tenantDeletions = pgTable("tenant_deletions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  tenantSlugSnapshot: text("tenant_slug_snapshot").notNull(),
  ownerEmailSnapshot: text("owner_email_snapshot"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  reason: text("reason"),
});

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
    // Phase 6: when both set, SaleForm uses this template for the receipt
    // path instead of sending a PDF. Bypasses the 24h window.
    receiptTemplateName: text("receipt_template_name"),
    receiptTemplateLanguage: text("receipt_template_language"),
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
    /** Receipt designer (migration 0029) — owner-customisable block order
     *  and font. `receiptBlockOrder` is a JSONB string array; null = default.
     *  Logo URL re-uses the historical `logo_path` column. */
    receiptBlockOrder: jsonb("receipt_block_order").$type<string[] | null>(),
    receiptFontFamily: text("receipt_font_family").notNull().default("cairo"),
    /** Receipt designer v2 (0030) — owner-defined text blocks the renderer
     *  splices in by ID via the "custom:<id>" entries in block order. */
    receiptCustomBlocks: jsonb("receipt_custom_blocks")
      .$type<Record<string, { text: string; align: "right" | "center" | "left" }>>()
      .notNull()
      .default({}),
    /** Receipt identity fields (migration 0065). All optional — when blank
     *  the renderer omits the row entirely, never a placeholder. */
    receiptTaxRegistration: text("receipt_tax_registration"),
    receiptTaxCardNumber: text("receipt_tax_card_number"),
    receiptSlogan: text("receipt_slogan"),
    receiptReturnPolicy: text("receipt_return_policy"),
    receiptAddress: text("receipt_address"),
    /** Short uppercase prefix stamped in front of the invoice short code at
     *  the receipt footer ("INV-A1B2C3"). Max 8 chars in the UI. */
    receiptReferencePrefix: text("receipt_reference_prefix"),
    /** Per-row visibility toggles (migration 0066). Default TRUE so a filled
     *  field still prints unless the Owner flips it off. Lets them hide a row
     *  WITHOUT clearing the text (e.g. suspend return policy during a promo). */
    receiptShowAddress: boolean("receipt_show_address").notNull().default(true),
    receiptShowSlogan: boolean("receipt_show_slogan").notNull().default(true),
    receiptShowTaxInfo: boolean("receipt_show_tax_info").notNull().default(true),
    receiptShowReturnPolicy: boolean("receipt_show_return_policy").notNull().default(true),
    /** Per-row alignment overrides (migration 0067). Keys are identity row
     *  names ("name", "address", "phone", "slogan", "taxReg", "taxCard",
     *  "returnPolicy", "footerText"); values are "left" | "center" | "right".
     *  Missing key → center fallback (today's shape). */
    receiptBlockAlignments: jsonb("receipt_block_alignments")
      .$type<Record<string, "left" | "center" | "right">>()
      .notNull()
      .default({}),
    /** Cash drawer reconciliation (migration 0032). When enabled, every cash
     *  sale/expense requires an open shift; close-shift wizard surfaces the
     *  Z-report. Defaults to off so existing tenants aren't blocked at upgrade. */
    cashReconciliationEnabled: boolean("cash_reconciliation_enabled")
      .notNull()
      .default(false),
    /** Variance threshold (EGP) at which the close-shift wizard makes the
     *  closing note mandatory. Default 50. */
    cashVarianceNoteThreshold: text("cash_variance_note_threshold")
      .notNull()
      .default("50"),
    /** Digital collections (0055, doc 15) — per-branch switches. */
    collectionsEnabled: boolean("collections_enabled").notNull().default(false),
    collectionsRequireAccount: boolean("collections_require_account").notNull().default(true),
    /** CHECK 15..1440 (Q15). */
    collectionsStaleAfterMinutes: integer("collections_stale_after_minutes").notNull().default(120),
    collectionsAutoConfirmEnabled: boolean("collections_auto_confirm_enabled")
      .notNull()
      .default(false),
    collectionsStorePayerNames: boolean("collections_store_payer_names").notNull().default(false),
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
    /** Product photo (migration 0051). Relative URL under
     *  /api/uploads/product-image/<tenant>/products/<uuid>.<ext>; null = no photo. */
    imageUrl: text("image_url"),
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
    // 'created' | 'updated' | 'restocked' | 'decreased' | 'sold' | 'returned'.
    // An offline oversell (S7) appends a 'restocked' row whose note starts
    // "oversell:" — the +delta reconciles the per-line 'sold' rows to the
    // floor (0) the product actually landed on; the queryable record is
    // stock_discrepancies below.
    type: text("type").notNull(),
    delta: integer("delta"),
    quantityAfter: integer("quantity_after"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("product_history_tenant_product_idx").on(t.tenantId, t.productId)],
);

// S7 (doc 02 §2.2 S13, migration 0050): one row per product an offline
// replay sold past its shelf with `allowOversell: true`. The sale is booked
// as rung, the product is driven to 0, and this row is what the owner
// reviews — `requested - available` is the phantom quantity that was sold
// but never counted in.
export const stockDiscrepancies = pgTable(
  "stock_discrepancies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    productId: uuid("product_id").notNull(),
    productName: text("product_name").notNull(),
    invoiceId: text("invoice_id").notNull(),
    requested: integer("requested").notNull(),
    available: integer("available").notNull(),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("stock_discrepancies_tenant_created_idx").on(t.tenantId, t.createdAt)],
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
    /** Running total paid against this sale. For non-deferred sales it
     *  always equals total_price. For deferred sales it starts at the
     *  amount the customer paid at the counter (often 0) and grows as
     *  later settlements come in. Outstanding balance = total_price -
     *  amount_paid. Migration 0037. */
    amountPaid: text("amount_paid").notNull().default("0"),
    /** Timestamp of the most-recent partial payment (i.e. a payment that
     *  did NOT fully settle the row). Null when the sale is paid in full
     *  or has never received a payment. Migration 0037. */
    partialPaidAt: timestamp("partial_paid_at", { withTimezone: true }),
    /** The user (cashier or owner) who recorded this sale. Null on legacy rows. */
    recordedByUserId: uuid("recorded_by_user_id"),
    /** Cash drawer shift this sale was recorded on. Null on non-cash sales,
     *  legacy rows, or when reconciliation isn't enabled for the branch. */
    cashShiftId: uuid("cash_shift_id"),
    /** The Idempotency-Key the offline outbox sent with the cart this row
     *  anchors — set on the cart's FIRST line only, null everywhere else.
     *  Backs the durable half of POST /api/sales/cart's replay protection
     *  (migration 0054; Redis keeps the fast path). */
    idempotencyKey: text("idempotency_key"),
    /** Digital collections (migration 0055, doc 15): 'pending' | 'confirmed' |
     *  'rejected' (CHECK); NULL = not a digital sale or collections were off.
     *  Orthogonal to isPaid/amountPaid; written on EVERY line of the invoice. */
    collectionStatus: text("collection_status"),
    /** Sales channel (migration 0057): 'store' (in-person at the till) or
     *  'online' (WhatsApp / Instagram / phone orders). Default 'store' so the
     *  POS stays one tap; the mobile Sales screen exposes a toggle at the
     *  top. Written on EVERY line of a cart. Analytics splits today's
     *  revenue and the insights chart on this. */
    channel: text("channel").notNull().default("store"),
  },
  (t) => [
    index("sales_tenant_date_idx").on(t.tenantId, t.saleDate),
    index("sales_tenant_invoice_idx").on(t.tenantId, t.invoiceId),
    index("sales_tenant_phone_idx").on(t.tenantId, t.customerPhone),
    index("sales_tenant_product_idx").on(t.tenantId, t.productId),
    index("sales_tenant_recorded_by_idx").on(t.tenantId, t.recordedByUserId),
    index("sales_tenant_branch_date_idx").on(t.tenantId, t.branchId, t.saleDate),
    uniqueIndex("sales_tenant_idempotency_key_idx")
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    index("sales_tenant_collection_pending_idx")
      .on(t.tenantId, t.saleDate)
      .where(sql`collection_status = 'pending'`),
  ],
);

/** Migration 0038. Every individual payment event recorded against a sale
 *  row. Multiple rows per sale = the payment timeline (initial down-payment
 *  + later settlements). `method = 'initial'` flags rows back-filled from
 *  pre-0038 data (one row per existing sale with amount_paid > 0). */
export const salePayments = pgTable(
  "sale_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    amount: text("amount").notNull(),
    /** 'cash' | 'instapay' | 'wallet' | 'card' | 'initial' (back-fill). */
    method: text("method").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** SET NULL on user delete so the timeline survives staff removal. */
    recordedByUserId: uuid("recorded_by_user_id"),
    /** When this payment was collected on an active cash shift. Links the
     *  customer-settlement to the same shift's cash drawer for Z-report. */
    cashShiftId: uuid("cash_shift_id"),
    note: text("note"),
    /** 0055: the pending digital collection this settlement created (FK → collections,
     *  SET NULL, declared in SQL). */
    collectionId: uuid("collection_id"),
    /** 0055: set when that collection was rejected — excluded from every sum,
     *  shown struck through in the ledger. */
    voidedAt: timestamp("voided_at", { withTimezone: true }),
  },
  (t) => [
    index("sale_payments_sale_idx").on(t.saleId, t.recordedAt),
    index("sale_payments_tenant_date_idx").on(t.tenantId, t.recordedAt),
    index("sale_payments_collection_idx")
      .on(t.collectionId)
      .where(sql`collection_id IS NOT NULL`),
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
    /** Cash drawer shift the cash refund was paid from. Null when the
     *  original sale wasn't cash, or reconciliation isn't enabled. */
    cashShiftId: uuid("cash_shift_id"),
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
    /** LEGACY: flat enum (rent | salaries | electricity | water | internet |
     *  supplier | other). Migration 0064 added `categoryId` as the new source
     *  of truth; the legacy string is backfilled onto a seeded subcategory and
     *  kept for back-compat with code paths that have not switched yet. */
    category: text("category").notNull(),
    /** Migration 0064. FK into the hierarchical financial_categories tree.
     *  Nullable because: pre-migration rows survive without FK; backfill sets
     *  it; new writers set it; code paths that still use the legacy string
     *  continue to insert with categoryId NULL safely. */
    categoryId: uuid("category_id"),
    /** Migration 0064. Payment method — same enum as salePayments.method. */
    paymentMethod: text("payment_method"),
    referenceNumber: text("reference_number"),
    /** Migration 0064. Lifecycle — 'posted' (default) | 'voided'. Voided
     *  rows are excluded from every P&L aggregation. */
    status: text("status").notNull().default("posted"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id"),
    voidReason: text("void_reason"),
    createdByUserId: uuid("created_by_user_id"),
    /** Optional supplier this expense pays. When set, the supplier's running balance is debited. */
    supplierId: uuid("supplier_id"),
    /** When true, this expense is a recurring template; child instances spawn at next_occurrence_date. */
    isRecurring: boolean("is_recurring").notNull().default(false),
    /** 'monthly' | 'weekly' — only meaningful when is_recurring=true. */
    recurrencePeriod: text("recurrence_period"),
    /** Next time this template should spawn a child instance (null when not recurring or done). */
    nextOccurrenceDate: timestamp("next_occurrence_date", { withTimezone: true }),
    /** Set on auto-generated child instances; points back at the recurring template.
     *  Migration 0064 adds a partial UNIQUE index on
     *  (tenant_id, parent_expense_id, date) so repeated generation never
     *  creates a second child for the same template/date pair. */
    parentExpenseId: uuid("parent_expense_id"),
    date: timestamp("date", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    note: text("note"),
    /** Cash drawer shift this expense was paid from. Set only for
     *  cash-paid expenses recorded while a shift is open. */
    cashShiftId: uuid("cash_shift_id"),
  },
  (t) => [
    index("expenses_tenant_date_idx").on(t.tenantId, t.date),
    index("expenses_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    index("expenses_tenant_recurring_idx").on(t.tenantId, t.isRecurring, t.nextOccurrenceDate),
    index("expenses_tenant_branch_date_idx").on(t.tenantId, t.branchId, t.date),
    index("expenses_tenant_status_date_idx").on(t.tenantId, t.status, t.date),
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
    /** Running amount paid against this PO. Settled when paidAmount = total. */
    paidAmount: text("paid_amount").notNull().default("0"),
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
    /** Owner-picked category for external (productId IS NULL) lines.
     *  receivePurchaseOrder uses this to file the materialised product
     *  instead of falling back to the tenant's first category. */
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  },
  (t) => [
    index("po_items_tenant_po_idx").on(t.tenantId, t.purchaseOrderId),
  ],
);

export const purchaseOrderPayments = pgTable(
  "purchase_order_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "restrict",
    }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    amount: text("amount").notNull(),
    method: text("method").notNull().default("cash"),
    paidAt: timestamp("paid_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("po_payments_tenant_po_idx").on(t.tenantId, t.purchaseOrderId),
    index("po_payments_tenant_supplier_date_idx").on(
      t.tenantId,
      t.supplierId,
      t.paidAt,
    ),
  ],
);

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  purchaseOrders: many(purchaseOrders),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ many, one }) => ({
  items: many(purchaseOrderItems),
  payments: many(purchaseOrderPayments),
  supplier: one(suppliers, {
    fields: [purchaseOrders.supplierId],
    references: [suppliers.id],
  }),
}));

export const purchaseOrderPaymentsRelations = relations(
  purchaseOrderPayments,
  ({ one }) => ({
    purchaseOrder: one(purchaseOrders, {
      fields: [purchaseOrderPayments.purchaseOrderId],
      references: [purchaseOrders.id],
    }),
    supplier: one(suppliers, {
      fields: [purchaseOrderPayments.supplierId],
      references: [suppliers.id],
    }),
  }),
);

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
// Cash drawer reconciliation (scoped) — RLS applied in a separate migration step
// ─────────────────────────────────────────────────────────────────────────────

export const cashShifts = pgTable(
  "cash_shifts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    cashierUserId: uuid("cashier_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** 'open' | 'closed' | 'reviewed' */
    status: text("status").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    openingFloat: text("opening_float").notNull().default("0"),
    openingNote: text("opening_note"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expectedCash: text("expected_cash"),
    countedCash: text("counted_cash"),
    /** Generated column: counted - expected. Read-only from app side. */
    variance: text("variance"),
    closingNote: text("closing_note"),
    /** 'cashier' | 'auto_midnight' | 'forced' */
    closeReason: text("close_reason"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewNote: text("review_note"),
    /** Frozen Z-report snapshot — see lib/repo/cash-shifts.ts for the shape. */
    totalsSnapshot: jsonb("totals_snapshot").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("cash_shifts_tenant_branch_date_idx").on(t.tenantId, t.branchId, t.openedAt),
    index("cash_shifts_tenant_cashier_idx").on(t.tenantId, t.cashierUserId, t.openedAt),
    // Partial unique + review-queue indexes are enforced in the SQL migration.
  ],
);

export const cashMovements = pgTable(
  "cash_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => cashShifts.id, { onDelete: "cascade" }),
    /** 'cash_in' | 'cash_out' | 'paid_in' | 'paid_out' */
    kind: text("kind").notNull(),
    amount: text("amount").notNull(),
    reason: text("reason").notNull(),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("cash_movements_shift_idx").on(t.shiftId, t.recordedAt),
    index("cash_movements_tenant_idx").on(t.tenantId, t.recordedAt),
  ],
);

export const cashShiftsRelations = relations(cashShifts, ({ many, one }) => ({
  movements: many(cashMovements),
  cashier: one(users, {
    fields: [cashShifts.cashierUserId],
    references: [users.id],
  }),
}));

export const cashMovementsRelations = relations(cashMovements, ({ one }) => ({
  shift: one(cashShifts, {
    fields: [cashMovements.shiftId],
    references: [cashShifts.id],
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Daily owner digest (scoped) — RLS applied in a separate migration step
// ─────────────────────────────────────────────────────────────────────────────

export interface DigestExtraRecipient {
  name: string;
  phone?: string | null;
  email?: string | null;
  locale?: "ar" | "en" | null;
}

export const digestSettings = pgTable("digest_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  /** Hour (0-23) in tenant-local tz. 0 = midnight end-of-day digest. */
  digestHour: integer("digest_hour").notNull().default(0),
  /** Where the digest goes. Deliberately separate from receipt-sending
   *  WhatsApp credentials and from tenant_members.phone — the owner may
   *  want to use their personal WhatsApp without touching either. */
  ownerPhone: text("owner_phone"),
  sendOnEmpty: boolean("send_on_empty").notNull().default(false),
  emailFallback: boolean("email_fallback").notNull().default(true),
  extraRecipients: jsonb("extra_recipients")
    .$type<DigestExtraRecipient[]>()
    .notNull()
    .default([]),
  managersSubscribed: uuid("managers_subscribed")
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const digestRuns = pgTable(
  "digest_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    businessDate: text("business_date").notNull(),
    recipientUserId: uuid("recipient_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    recipientPhone: text("recipient_phone"),
    recipientEmail: text("recipient_email"),
    /** 'whatsapp' | 'email' | 'email_fallback' */
    channel: text("channel").notNull(),
    /** 'pending' | 'sent' | 'failed' | 'skipped_empty' | 'skipped_no_channel' */
    status: text("status").notNull().default("pending"),
    error: text("error"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    messageText: text("message_text"),
    whatsappMessageId: text("whatsapp_message_id"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("digest_runs_tenant_date_idx").on(t.tenantId, t.businessDate),
    // Idempotency unique indexes live in the SQL migration (partial indexes).
  ],
);

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
    /** Flat % 0..100 applied to the commission base. V1 ships a single rate per employee. */
    commissionRate: text("commission_rate").notNull().default("0"),
    /** 'gross_sales' | 'profit_contribution'. V1 only supports gross_sales. */
    commissionBase: text("commission_base").notNull().default("gross_sales"),
    /** Owner opt-in: when true, this employee may receive monthly `payrollAdjustments` rows. */
    bonusEligible: boolean("bonus_eligible").notNull().default(false),
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
    /** Legacy pre-V1 "lump adjustment" column. V1 writes `adjustmentsTotal`
     *  instead; kept here so reads of pre-V1 rows still work. */
    adjustmentsAmount: text("adjustments_amount").notNull().default("0"),
    adjustmentsNote: text("adjustments_note"),
    /** Engine's full output at finalize: hours, leave, sales, commission math,
     *  per-adjustment breakdown, warnings. Shape evolves with `calculationVersion`. */
    snapshot: jsonb("snapshot"),
    /** The `employeeCompensation` row that was in force at finalize time,
     *  frozen so later edits cannot rewrite history. */
    compensationSnapshot: jsonb("compensation_snapshot"),
    /** Bump when the engine's math changes. Readers can surface "v2 math" context. */
    calculationVersion: integer("calculation_version").notNull().default(1),
    /** V1 totals, stored even though derivable from `snapshot`. */
    commissionAmount: text("commission_amount").notNull().default("0"),
    /** Sum of `payrollAdjustments.amount` (signed) folded in at finalize. */
    adjustmentsTotal: text("adjustments_total").notNull().default("0"),
    /** `grossAmount + commissionAmount + adjustmentsTotal`. */
    netAmount: text("net_amount").notNull().default("0"),
    /** 'draft' | 'finalized' | 'voided' */
    status: text("status").notNull().default("draft"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedByUserId: uuid("finalized_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("payroll_periods_tenant_employee_period_idx").on(
      t.tenantId,
      t.employeeId,
      t.periodStart,
    ),
    index("payroll_periods_tenant_period_status_idx").on(
      t.tenantId,
      t.periodStart,
      t.status,
    ),
  ],
);

/**
 * Owner-authored monthly bonus / deduction entries. Summed into
 * `payroll_periods.adjustments_total` at calculate time and frozen into the
 * snapshot at finalize. Positive for bonuses, negative for deductions /
 * advance repayments; `kind` is a UI label the Owner picks.
 */
export const payrollAdjustments = pgTable(
  "payroll_adjustments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** First-of-month UTC midnight. Joins to `payrollPeriods.periodStart`. */
    periodMonth: timestamp("period_month", { withTimezone: true }).notNull(),
    /** 'bonus' | 'deduction' | 'advance_repayment' | 'correction' */
    kind: text("kind").notNull(),
    amount: text("amount").notNull(),
    reason: text("reason"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    index("payroll_adjustments_tenant_employee_month_idx").on(
      t.tenantId,
      t.employeeId,
      t.periodMonth,
    ),
    index("payroll_adjustments_tenant_month_idx").on(t.tenantId, t.periodMonth),
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
    /** 'paid' | 'unpaid'. Paid leave counts toward fixed salary; unpaid reduces it.
     *  The approver sets this when approving the request. */
    kind: text("kind").notNull().default("unpaid"),
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

// Per-user notification preferences (migration 0044). A row exists only when
// the user has flipped a channel away from the code default; the dispatcher
// treats a missing row as "use lib/notifications/event-types.ts default".
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Matches NotificationEventType in lib/notifications/event-types.ts. */
    eventType: text("event_type").notNull(),
    inApp: boolean("in_app").notNull().default(true),
    /** Phone push for this event (migration 0048_push_receipts). Independent
     *  of `inApp` so "show it in the bell, don't buzz me" is expressible. */
    push: boolean("push").notNull().default(true),
    email: boolean("email").notNull().default(false),
    /** 'instant' | 'digest' — digest buffers to notification_digest_queue. */
    digestMode: text("digest_mode").notNull().default("instant"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("notification_preferences_uniq").on(
      t.tenantId,
      t.userId,
      t.eventType,
    ),
    index("notification_preferences_tenant_event_idx").on(t.tenantId, t.eventType),
  ],
);

// Expo push tokens (migration 0048). One row per (install, user). Rows are
// disabled, never deleted: Expo's DeviceNotRegistered ticket, an explicit
// DELETE, and logout all set `disabledAt`. `expoToken` is globally unique so
// a token that reappears under a different user is re-owned, not duplicated.
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `ExponentPushToken[...]` / `ExpoPushToken[...]`. */
    expoToken: text("expo_token").notNull().unique(),
    /** 'ios' | 'android' */
    platform: text("platform").notNull(),
    deviceName: text("device_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Non-null means "do not send". */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [
    index("push_tokens_tenant_user_live_idx")
      .on(t.tenantId, t.userId)
      .where(sql`${t.disabledAt} IS NULL`),
    check("push_tokens_platform_check", sql`${t.platform} IN ('ios', 'android')`),
  ],
);

// Push receipts queue (migration 0048_push_receipts). One row per `ok` Expo
// ticket; the cron asks Expo for the receipt ~15 min later and disables the
// token on DeviceNotRegistered. Rows are deleted once checked or once stale.
export const pushReceipts = pgTable(
  "push_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expoToken: text("expo_token").notNull(),
    ticketId: text("ticket_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("push_receipts_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

// Digest queue (migration 0045). Populated when a user's preference for a
// high-volume event is `email + digest`. The daily cron drains it.
export const notificationDigestQueue = pgTable(
  "notification_digest_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    // Partial index (WHERE sent_at IS NULL) — defined in migration.
    index("notification_digest_queue_tenant_user_idx").on(
      t.tenantId,
      t.userId,
      t.createdAt,
    ),
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
   *  - 'trial'        — fresh signup, full access during TRIAL_DAYS window
   *  - 'professional' — single store, full feature set, paid monthly
   *  - 'multi_branch' — placeholder; gated behind future multi-branch work
   */
  plan: text("plan").notNull().default("trial"),
  /**
   * Lifecycle:
   *  - 'trialing'   — inside the trial window (TRIAL_DAYS)
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
    // Set only on successful /debug_token. Drives the "token validated
    // X ago" hint in the settings UI.
    tokenLastValidatedAt: timestamp("token_last_validated_at", {
      withTimezone: true,
    }),
    // Set on each full health-check run regardless of outcome. Throttles
    // the UI's "Run check" button.
    lastGraphHealthcheckAt: timestamp("last_graph_healthcheck_at", {
      withTimezone: true,
    }),
    // Machine-readable health code; see migration 0020 for the value
    // domain. Null = never checked.
    connectionErrorState: text("connection_error_state"),
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

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp webhook event store (Phase 2).
//
// Internal admin-only audit log. Quarantine rows (tenant_id NULL) need
// cross-tenant visibility so RLS is intentionally NOT enabled on this
// table. The inspection endpoint gates on owner role + filters by
// tenantId at the SQL level.
// ─────────────────────────────────────────────────────────────────────────────

export const waWebhookEvents = pgTable(
  "wa_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull().default("meta_cloud"),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),

    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "set null",
    }),
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "set null",
    }),
    connectionId: uuid("connection_id").references(() => waConnections.id, {
      onDelete: "set null",
    }),

    phoneNumberId: text("phone_number_id"),
    wabaId: text("waba_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),

    processingStatus: text("processing_status").notNull().default("pending"),
    retryCount: integer("retry_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    errorDetails: text("error_details"),

    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    processedAt: timestamp("processed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("wa_webhook_events_provider_event_uniq").on(
      t.provider,
      t.providerEventId,
    ),
    index("wa_webhook_events_tenant_idx").on(t.tenantId),
    index("wa_webhook_events_status_idx").on(t.processingStatus),
    index("wa_webhook_events_phone_idx").on(t.phoneNumberId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp messages — normalised inbound + outbound (Phase 2).
// Tenant-scoped via RLS.
// ─────────────────────────────────────────────────────────────────────────────

export const waMessages = pgTable(
  "wa_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => waConnections.id, {
      onDelete: "set null",
    }),

    provider: text("provider").notNull().default("meta_cloud"),
    direction: text("direction").notNull(), // 'inbound' | 'outbound'

    metaMessageId: text("meta_message_id"),
    clientMessageId: text("client_message_id"),

    contactPhoneNumber: text("contact_phone_number").notNull(),
    contactWaId: text("contact_wa_id"),

    messageType: text("message_type").notNull(),
    textBody: text("text_body"),
    mediaId: text("media_id"),
    mediaMimeType: text("media_mime_type"),
    mediaFilename: text("media_filename"),
    mediaSha256: text("media_sha256"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),

    status: text("status"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    failureCode: integer("failure_code"),

    receivedAt: timestamp("received_at", { withTimezone: true }),

    conversationId: text("conversation_id"),
    conversationCategory: text("conversation_category"),
    conversationOrigin: text("conversation_origin"),
    pricingCategory: text("pricing_category"),
    pricingModel: text("pricing_model"),
    pricingBillable: boolean("pricing_billable"),

    // Phase 4: link to the wa_conversations aggregate row. Nullable so
    // historical messages from Phases 2-3 (before the table existed)
    // remain valid; new writes populate it.
    conversationRowId: uuid("conversation_row_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("wa_messages_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("wa_messages_contact_idx").on(
      t.tenantId,
      t.branchId,
      t.contactPhoneNumber,
    ),
    index("wa_messages_status_idx").on(t.tenantId, t.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp contacts + conversations (Phase 4). Both tenant-scoped, RLS-forced.
// ─────────────────────────────────────────────────────────────────────────────

export const waContacts = pgTable(
  "wa_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    phoneNumber: text("phone_number").notNull(),
    waId: text("wa_id"),
    displayName: text("display_name"),
    merchantLabel: text("merchant_label"),
    tags: text("tags"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("wa_contacts_tenant_branch_phone_uniq").on(
      t.tenantId,
      t.branchId,
      t.phoneNumber,
    ),
    index("wa_contacts_tenant_branch_idx").on(t.tenantId, t.branchId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Meta message templates (Phase 5). Cache of WABA-scoped templates with
// status + components so the send path can refer to a template by name
// without re-fetching from Meta on every send.
// ─────────────────────────────────────────────────────────────────────────────

export const waTemplates = pgTable(
  "wa_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => waConnections.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull().default("meta_cloud"),

    metaTemplateId: text("meta_template_id"),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull(),

    components: jsonb("components")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    qualityScore: jsonb("quality_score").$type<Record<string, unknown>>(),
    rejectedReason: text("rejected_reason"),
    parameterFormat: text("parameter_format"),

    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("wa_templates_branch_name_lang_uniq").on(
      t.tenantId,
      t.branchId,
      t.name,
      t.language,
    ),
    index("wa_templates_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("wa_templates_status_idx").on(t.tenantId, t.status),
  ],
);

export const waConversations = pgTable(
  "wa_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => waContacts.id, { onDelete: "cascade" }),
    phoneNumber: text("phone_number").notNull(),

    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessagePreview: text("last_message_preview"),
    lastMessageDirection: text("last_message_direction"),
    unreadCount: integer("unread_count").notNull().default(0),

    windowExpiresAt: timestamp("window_expires_at", { withTimezone: true }),

    lastConversationId: text("last_conversation_id"),
    lastConversationCategory: text("last_conversation_category"),

    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("wa_conversations_tenant_branch_contact_uniq").on(
      t.tenantId,
      t.branchId,
      t.contactId,
    ),
    index("wa_conversations_tenant_branch_last_idx").on(
      t.tenantId,
      t.branchId,
      t.lastMessageAt,
    ),
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
export type WaWebhookEventRow = typeof waWebhookEvents.$inferSelect;
export type NewWaWebhookEvent = typeof waWebhookEvents.$inferInsert;
export type WaMessageRow = typeof waMessages.$inferSelect;
export type NewWaMessage = typeof waMessages.$inferInsert;
export type WaContactRow = typeof waContacts.$inferSelect;
export type NewWaContact = typeof waContacts.$inferInsert;
export type WaConversationRow = typeof waConversations.$inferSelect;
export type NewWaConversation = typeof waConversations.$inferInsert;
export type WaTemplateRow = typeof waTemplates.$inferSelect;
export type NewWaTemplate = typeof waTemplates.$inferInsert;
export type PayrollPeriodRow = typeof payrollPeriods.$inferSelect;
export type NewPayrollPeriod = typeof payrollPeriods.$inferInsert;
export type PayrollAdjustmentRow = typeof payrollAdjustments.$inferSelect;
export type NewPayrollAdjustment = typeof payrollAdjustments.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Platform admin (godmode) — see docs/specs/platform-admin-dashboard.md.
//
// These tables sit OUTSIDE the tenant RLS model. They have no tenant_id;
// access is enforced at the application layer via the admin session cookie
// + the matgary_admin DB role (BYPASSRLS). Tenant-facing code must never
// import from lib/admin/* (ESLint rule guards this).
// ─────────────────────────────────────────────────────────────────────────────

export const admins = pgTable("admins", {
  id: uuid("id").defaultRandom().primaryKey(),
  // citext at the DB level; Drizzle treats it as text for the TS surface.
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  /** 'super_admin' | 'ops_admin' */
  role: text("role").notNull().default("ops_admin"),
  mustRotate: boolean("must_rotate").notNull().default(false),
  totpSecret: text("totp_secret"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  lastLoginIp: text("last_login_ip"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  createdByAdminId: uuid("created_by_admin_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    sessionToken: text("session_token").notNull().unique(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** Reserved for Spec 07 (impersonation). NULL = normal admin browsing. */
    impersonatingTenantId: uuid("impersonating_tenant_id"),
    impersonatingUserId: uuid("impersonating_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("admin_sessions_admin_idx").on(t.adminId),
    index("admin_sessions_token_idx").on(t.sessionToken),
  ],
);

export const adminPasswordHistory = pgTable(
  "admin_password_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("admin_pw_history_admin_idx").on(t.adminId, t.changedAt)],
);

export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Nullable + SET NULL (migration 0035) so a hard-deleted admin's
    // historical audit rows survive with admin_id=null. The UI renders
    // "(deleted)" when the join to admins returns no row.
    adminId: uuid("admin_id").references(() => admins.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetKind: text("target_kind"),
    targetId: uuid("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    beforeJsonb: jsonb("before_jsonb"),
    afterJsonb: jsonb("after_jsonb"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("admin_audit_admin_time_idx").on(t.adminId, t.occurredAt),
    index("admin_audit_target_idx").on(t.targetKind, t.targetId),
  ],
);

// For Spec 04. Created in 0034 so the schema only changes once.
export const platformPlans = pgTable("platform_plans", {
  key: text("key").primaryKey(),
  labelAr: text("label_ar").notNull(),
  labelEn: text("label_en").notNull(),
  taglineAr: text("tagline_ar").notNull(),
  taglineEn: text("tagline_en").notNull(),
  monthlyEgp: integer("monthly_egp").notNull().default(0),
  purchasable: boolean("purchasable").notNull().default(false),
  featuresAr: text("features_ar").array().notNull().default(sql`'{}'::text[]`),
  featuresEn: text("features_en").array().notNull().default(sql`'{}'::text[]`),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedByAdminId: uuid("updated_by_admin_id"),
});

// For Spec 06. Created in 0034 so the schema only changes once.
export const platformBroadcasts = pgTable("platform_broadcasts", {
  id: uuid("id").defaultRandom().primaryKey(),
  titleAr: text("title_ar").notNull(),
  titleEn: text("title_en").notNull(),
  bodyAr: text("body_ar"),
  bodyEn: text("body_en"),
  /** 'info' | 'warning' | 'critical' */
  severity: text("severity").notNull().default("info"),
  /** 'all' | 'owners' | 'staff' */
  audience: text("audience").notNull().default("all"),
  startsAt: timestamp("starts_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  createdByAdminId: uuid("created_by_admin_id"),
});

export type AdminRow = typeof admins.$inferSelect;
export type NewAdmin = typeof admins.$inferInsert;
export type AdminSessionRow = typeof adminSessions.$inferSelect;
export type AdminAuditLogRow = typeof adminAuditLog.$inferSelect;
export type PlatformPlanRow = typeof platformPlans.$inferSelect;
export type PlatformBroadcastRow = typeof platformBroadcasts.$inferSelect;
export type PushTokenRow = typeof pushTokens.$inferSelect;
export type PushReceiptRow = typeof pushReceipts.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Digital collections (mobile-dev-docs/15-digital-collections, spec 04).
// Mirrors migrations 0055 (M1: accounts, collections, events) and 0056 (M2:
// ingest devices, raw messages, credits). Names are 03-architecture.md §B.2.
// Columns, FKs and every index are declared here; the CHECK constraints live
// in the SQL only and tests/unit/collections-schema.test.ts pins their value
// lists against the domain unions. Money is numeric(14,2) → string in TS.
// Three FKs close a cycle (collections ↔ credits, events → devices/credits);
// they are plain uuid columns here and real FKs in 0056.
// ─────────────────────────────────────────────────────────────────────────────

/** 0055. The owner's receiving accounts (InstaPay-reachable bank accounts,
 *  wallets). Soft-deleted only (`archivedAt`): collections reference them. */
export const collectionAccounts = pgTable(
  "collection_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** NULL = every branch of the tenant. */
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    /** CollectionRail — 'instapay' | 'wallet' (CHECK). */
    rail: text("rail").notNull(),
    /** CollectionProvider — domain registry, no CHECK (a bank is added without a migration). */
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    holderName: text("holder_name"),
    /** lower-case `name@instapay` (CHECK). */
    ipaHandle: text("ipa_handle"),
    /** `https://ipn.eg/S/<handle>/instapay/<id>` — validated by domain `isValidIpaLink`, no CHECK.
     *  UNVERIFIED (doc 15 FN-17, 03 §B.2.1): the shape comes from an unofficial community
     *  SDK and has not been checked against a real InstaPay link yet. It is enforced in app
     *  code only, so a corrected shape is a code change, never a migration. */
    ipaLink: text("ipa_link"),
    accountLast4: text("account_last4"),
    isPrepaidCard: boolean("is_prepaid_card").notNull().default(false),
    /** Full value only to `manage_collection_accounts`. */
    iban: text("iban"),
    /** E.164 `+201[0125]XXXXXXXX`. */
    walletMsisdn: text("wallet_msisdn"),
    walletOpenedOn: date("wallet_opened_on", { mode: "string" }),
    isDefaultForMobile: boolean("is_default_for_mobile").notNull().default(false),
    isPosDefault: boolean("is_pos_default").notNull().default(false),
    autoConfirmEnabled: boolean("auto_confirm_enabled").notNull().default(false),
    /** Credits above it never auto-confirm (Q16). */
    reviewThreshold: numeric("review_threshold", { precision: 14, scale: 2 })
      .notNull()
      .default("5000.00"),
    balanceCheckEnabled: boolean("balance_check_enabled").notNull().default(true),
    balanceBaseline: numeric("balance_baseline", { precision: 14, scale: 2 }),
    balanceBaselineAt: timestamp("balance_baseline_at", { withTimezone: true }),
    balanceChainBrokenAt: timestamp("balance_chain_broken_at", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("collection_accounts_tenant_branch_idx")
      .on(t.tenantId, t.branchId)
      .where(sql`archived_at IS NULL`),
    uniqueIndex("collection_accounts_tenant_msisdn_uq")
      .on(t.tenantId, t.walletMsisdn)
      .where(sql`wallet_msisdn IS NOT NULL AND archived_at IS NULL`),
    uniqueIndex("collection_accounts_tenant_provider_last4_uq")
      .on(t.tenantId, t.provider, t.accountLast4)
      .where(sql`account_last4 IS NOT NULL AND archived_at IS NULL`),
    uniqueIndex("collection_accounts_pos_default_uq")
      .on(
        t.tenantId,
        sql`COALESCE(${t.branchId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.rail,
      )
      .where(sql`is_pos_default AND archived_at IS NULL`),
  ],
);

/** 0055. One row per expected transfer ("part", 1..4 per sale, Q5). */
export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    /** CollectionSourceType — 'sale' | 'settlement'. */
    sourceType: text("source_type").notNull(),
    invoiceId: text("invoice_id"),
    anchorSaleId: uuid("anchor_sale_id").references(() => sales.id, { onDelete: "set null" }),
    customerPhone: text("customer_phone"),
    /** DigitalMethod — 'instapay' | 'wallet'. */
    method: text("method").notNull(),
    /** NULL only with flag `account_missing`. */
    collectionAccountId: uuid("collection_account_id").references(() => collectionAccounts.id, {
      onDelete: "restrict",
    }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    partNo: smallint("part_no").notNull().default(1),
    /** CollectionStatus — pending | confirmed | auto_confirmed | rejected | void. */
    status: text("status").notNull().default("pending"),
    payerPhoneLast4: text("payer_phone_last4"),
    /** lower-case, 4..16 of [0-9a-z]. */
    payerReference: text("payer_reference"),
    rungAt: timestamp("rung_at", { withTimezone: true }).notNull(),
    recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** FK → collection_credits (SET NULL) in 0056; plain uuid here (cycle). */
    matchedCreditId: uuid("matched_credit_id"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    rejectOutcome: text("reject_outcome"),
    decisionNote: text("decision_note"),
    staleNotifiedAt: timestamp("stale_notified_at", { withTimezone: true }),
    /** CollectionFlag[] — zod-validated, no CHECK. */
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index("collections_tenant_status_rung_idx").on(t.tenantId, t.status, t.rungAt),
    index("collections_match_idx")
      .on(t.tenantId, t.collectionAccountId, t.amount, t.rungAt)
      .where(sql`status = 'pending'`),
    index("collections_tenant_invoice_idx").on(t.tenantId, t.invoiceId),
    index("collections_tenant_branch_rung_idx").on(t.tenantId, t.branchId, t.rungAt),
    // ON CONFLICT (tenant_id, invoice_id, part_no) WHERE source_type = 'sale' (spec 05).
    uniqueIndex("collections_sale_part_uq")
      .on(t.tenantId, t.invoiceId, t.partNo)
      .where(sql`source_type = 'sale'`),
    uniqueIndex("collections_matched_credit_uq")
      .on(t.matchedCreditId)
      .where(sql`matched_credit_id IS NOT NULL`),
  ],
);

/** 0055. Append-only audit trail; code never UPDATEs or DELETEs rows. */
export const collectionEvents = pgTable(
  "collection_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** CollectionEventKind (CHECK). */
    kind: text("kind").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    /** NULL = system. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** FK → collection_ingest_devices (SET NULL) in 0056; plain uuid here (cycle). */
    actorDeviceId: uuid("actor_device_id"),
    /** FK → collection_credits (SET NULL) in 0056; plain uuid here (cycle). */
    creditId: uuid("credit_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index("collection_events_collection_idx").on(t.collectionId, t.createdAt),
    index("collection_events_tenant_idx").on(t.tenantId, t.createdAt),
  ],
);

export type CollectionAccountRow = typeof collectionAccounts.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;
export type CollectionEventRow = typeof collectionEvents.$inferSelect;

/** 0056. Phones allowed to forward bank/wallet messages. NO RLS (bootstrap
 *  lookup by token hash, like auth_devices): every other query MUST filter
 *  tenant_id explicitly. */
export const collectionIngestDevices = pgTable(
  "collection_ingest_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    label: text("label").notNull(),
    /** IngestPlatform (CHECK). */
    platform: text("platform").notNull(),
    /** IngestChannel[] the device may post (CHECK: non-empty subset). */
    channels: text("channels").array().notNull(),
    /** Empty = all active accounts of the tenant/branch. */
    accountIds: uuid("account_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** SHA-256 hex of the `mgi_` token. The plaintext is shown once, never stored. */
    tokenHash: text("token_hash").notNull().unique("collection_ingest_devices_token_hash_uq"),
    tokenPrefix: text("token_prefix").notNull(),
    consentVersion: text("consent_version").notNull(),
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull(),
    consentUserId: uuid("consent_user_id").references(() => users.id, { onDelete: "set null" }),
    appVersion: text("app_version"),
    osVersion: text("os_version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastCreditAt: timestamp("last_credit_at", { withTimezone: true }),
    lastHeartbeat: jsonb("last_heartbeat").$type<Record<string, unknown>>(),
    silentAlertedAt: timestamp("silent_alerted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 'owner' | 'user_removed' | 'security' | 'replaced' (CHECK). */
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index("collection_ingest_devices_tenant_live_idx")
      .on(t.tenantId)
      .where(sql`revoked_at IS NULL`),
  ],
);

/** 0056. Forwarded text, AES-256-GCM encrypted, purged at `expiresAt` (03 §E.4). */
export const collectionRawMessages = pgTable(
  "collection_raw_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** NULL for manual_paste. */
    ingestDeviceId: uuid("ingest_device_id").references(() => collectionIngestDevices.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull(),
    sourceApp: text("source_app"),
    sender: text("sender"),
    senderKind: text("sender_kind").notNull(),
    clientFingerprint: text("client_fingerprint"),
    bodySha256: text("body_sha256").notNull(),
    /** NULL when parse_status = 'otp' (CHECK). */
    titleEnc: text("title_enc"),
    bodyEnc: text("body_enc"),
    parseStatus: text("parse_status").notNull(),
    templateId: text("template_id"),
    /** Device time. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sharedAt: timestamp("shared_at", { withTimezone: true }),
    sharedByUserId: uuid("shared_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    // ON CONFLICT (tenant_id, ingest_device_id, client_fingerprint) WHERE client_fingerprint IS NOT NULL (spec 07).
    uniqueIndex("collection_raw_messages_device_fp_uq")
      .on(t.tenantId, t.ingestDeviceId, t.clientFingerprint)
      .where(sql`client_fingerprint IS NOT NULL`),
    index("collection_raw_messages_expires_idx").on(t.expiresAt),
    index("collection_raw_messages_tenant_status_idx").on(t.tenantId, t.parseStatus, t.createdAt),
  ],
);

/** 0056. One row per real-world credit/debit after dedupe (SMS + notification collapse). */
export const collectionCredits = pgTable(
  "collection_credits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    collectionAccountId: uuid("collection_account_id").references(() => collectionAccounts.id, {
      onDelete: "restrict",
    }),
    ingestDeviceId: uuid("ingest_device_id").references(() => collectionIngestDevices.id, {
      onDelete: "set null",
    }),
    /** Survives the raw purge as NULL. */
    rawMessageId: uuid("raw_message_id").references(() => collectionRawMessages.id, {
      onDelete: "set null",
    }),
    /** CreditDirection (CHECK). */
    direction: text("direction").notNull(),
    channels: text("channels").array().notNull(),
    templateId: text("template_id").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    payerPhoneLast4: text("payer_phone_last4"),
    /** HMAC-SHA256 (purpose key `collections.phone`), equality only. */
    payerPhoneHmac: text("payer_phone_hmac"),
    payerNameMasked: text("payer_name_masked"),
    /** Only when shop_settings.collections_store_payer_names. */
    payerName: text("payer_name"),
    balanceAfter: numeric("balance_after", { precision: 14, scale: 2 }),
    operatorReference: text("operator_reference"),
    receivingHint: text("receiving_hint"),
    sender: text("sender"),
    senderKind: text("sender_kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    deviceReceivedAt: timestamp("device_received_at", { withTimezone: true }).notNull(),
    /** CreditState (CHECK). */
    state: text("state").notNull(),
    /** HoldReason (CHECK). */
    holdReason: text("hold_reason"),
    suggestedCollectionId: uuid("suggested_collection_id").references(() => collections.id, {
      onDelete: "set null",
    }),
    matchedCollectionId: uuid("matched_collection_id").references(() => collections.id, {
      onDelete: "set null",
    }),
    ignoredReason: text("ignored_reason"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** 03 §C.9: r:… | b:… | f:… */
    dedupeKey: text("dedupe_key").notNull(),
    seenCount: integer("seen_count").notNull().default(1),
    isTest: boolean("is_test").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("collection_credits_dedupe_uq").on(t.tenantId, t.dedupeKey),
    uniqueIndex("collection_credits_matched_uq")
      .on(t.matchedCollectionId)
      .where(sql`matched_collection_id IS NOT NULL`),
    index("collection_credits_tenant_state_idx").on(t.tenantId, t.state, t.occurredAt),
    index("collection_credits_match_idx").on(
      t.tenantId,
      t.collectionAccountId,
      t.amount,
      t.occurredAt,
    ),
  ],
);

export type CollectionIngestDeviceRow = typeof collectionIngestDevices.$inferSelect;
export type CollectionRawMessageRow = typeof collectionRawMessages.$inferSelect;
export type CollectionCreditRow = typeof collectionCredits.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// AI write confirmation — F5 §3. Server-side truth for every destructive AI
// action between preview and execute. Migration: 0058_ai_pending_actions.sql.
// ─────────────────────────────────────────────────────────────────────────────

export const aiPendingActions = pgTable(
  "ai_pending_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    /** e.g. 'update_product_price' | 'update_product_quantity' | 'create_customer'. */
    action: text("action").notNull(),
    /** Validated executor params captured at preview time. */
    params: jsonb("params").notNull().$type<Record<string, unknown>>(),
    /** What we showed the user (UI hint only — executor ignores). */
    preview: jsonb("preview").notNull().$type<Record<string, unknown>>(),
    /** HMAC-SHA256 hex over id|tenant|user|branch|action|canonical(params)|expires_at. */
    hmac: text("hmac").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("ai_pending_actions_tenant_user_idx").on(
      t.tenantId,
      t.userId,
      t.createdAt,
    ),
    index("ai_pending_actions_expiry_idx").on(t.expiresAt),
  ],
);

export type AiPendingActionRow = typeof aiPendingActions.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// F9 — AI knowledge / RAG. Tenant-isolated document + chunk store. Embedding
// stored as double precision[] (pgvector not available on postgres:16-alpine
// at the moment; migrating to vector(768) is a straight column-type swap).
// Migration: 0059_ai_knowledge.sql.
// ─────────────────────────────────────────────────────────────────────────────

export const aiKnowledgeDocuments = pgTable(
  "ai_knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    /** policy | sop | manual | faq | training | product_documentation | supplier_documentation | other */
    documentType: text("document_type").notNull(),
    /** upload | seed | api — diagnostic only. */
    source: text("source").notNull().default("upload"),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    /** ISO 639-1. Supports the F7 locales: ar, en, pt, fr, es. */
    language: text("language").notNull().default("en"),
    version: integer("version").notNull().default(1),
    /** Only is_current = true docs normally participate in retrieval. */
    isCurrent: boolean("is_current").notNull().default(true),
    /** pending | processing | ready | failed | archived */
    status: text("status").notNull().default("pending"),
    statusDetail: text("status_detail"),
    /** SHA-256 of normalised text — enables content-change detection. */
    contentHash: text("content_hash"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("ai_knowledge_documents_tenant_idx").on(
      t.tenantId,
      t.isCurrent,
      t.status,
    ),
    index("ai_knowledge_documents_tenant_branch_idx").on(
      t.tenantId,
      t.branchId,
      t.isCurrent,
      t.status,
    ),
  ],
);

export const aiKnowledgeChunks = pgTable(
  "ai_knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => aiKnowledgeDocuments.id, { onDelete: "cascade" }),
    documentVersion: integer("document_version").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    section: text("section"),
    language: text("language").notNull().default("en"),
    content: text("content").notNull(),
    /** Gemini text-embedding-004 → 768 dims. */
    embedding: doublePrecision("embedding").array().notNull(),
    embeddingModel: text("embedding_model")
      .notNull()
      .default("gemini-embedding-001"),
    tokenCount: integer("token_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("ai_knowledge_chunks_tenant_idx").on(t.tenantId),
    index("ai_knowledge_chunks_document_idx").on(t.documentId, t.chunkIndex),
  ],
);

export type AiKnowledgeDocumentRow = typeof aiKnowledgeDocuments.$inferSelect;
export type AiKnowledgeChunkRow = typeof aiKnowledgeChunks.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// F10.0 — Reversible AI operations. Every AI-executed mutation records one row
// here with the before/after state needed to safely restore. Rollback is a
// NEW operation that cites the original; audit trail stays immutable.
// Migration: 0060_ai_operations.sql.
// ─────────────────────────────────────────────────────────────────────────────

export const aiOperationGroups = pgTable(
  "ai_operation_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    /** 'import' | 'bulk_price_update' | 'batch' | … */
    groupType: text("group_type").notNull(),
    entityType: text("entity_type").notNull(),
    label: text("label").notNull(),
    /** created | in_progress | completed | failed | rolled_back | partially_rolled_back */
    status: text("status").notNull().default("created"),
    totalOperations: integer("total_operations").notNull().default(0),
    reversedOperations: integer("reversed_operations").notNull().default(0),
    conflictedOperations: integer("conflicted_operations").notNull().default(0),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("ai_operation_groups_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const aiOperations = pgTable(
  "ai_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    conversationId: uuid("conversation_id"),
    /** 'product.price.update' | 'product.quantity.update' |
     *  'product.quantity.adjust' | 'customer.create' | future. */
    operationType: text("operation_type").notNull(),
    pendingActionId: uuid("pending_action_id").references(
      () => aiPendingActions.id,
      { onDelete: "set null" },
    ),
    operationGroupId: uuid("operation_group_id").references(
      () => aiOperationGroups.id,
      { onDelete: "set null" },
    ),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    entityLabel: text("entity_label").notNull(),
    /** For composite-keyed entities (customer_wallets uses tenant/branch/phone). */
    entityKey: jsonb("entity_key").$type<Record<string, unknown> | null>(),
    beforeState: jsonb("before_state").notNull().$type<Record<string, unknown>>(),
    afterState: jsonb("after_state").notNull().$type<Record<string, unknown>>(),
    affectedFields: text("affected_fields").array().notNull().default(sql`'{}'::text[]`),
    reversible: boolean("reversible").notNull().default(true),
    /** recorded | rolled_back | rollback_blocked | partially_rolled_back */
    status: text("status").notNull().default("recorded"),
    statusReason: text("status_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    rollbackOperationId: uuid("rollback_operation_id"),
    actorName: text("actor_name"),
    idempotencyKey: text("idempotency_key"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("ai_operations_recent_idx").on(
      t.tenantId,
      t.userId,
      t.conversationId,
      t.createdAt,
    ),
    index("ai_operations_group_idx").on(t.operationGroupId, t.createdAt),
    index("ai_operations_entity_idx").on(
      t.tenantId,
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
  ],
);

export type AiOperationGroupRow = typeof aiOperationGroups.$inferSelect;
export type AiOperationRow = typeof aiOperations.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// F10.1 — AI Data Import Engine. Durable import sessions + row-level state so
// the conversational correction flow survives chat restarts and request retries.
// Migration: 0061_ai_import.sql.
// ─────────────────────────────────────────────────────────────────────────────

export const aiImportSessions = pgTable(
  "ai_import_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    conversationId: uuid("conversation_id"),
    entityType: text("entity_type").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileHash: text("file_hash").notNull(),
    fileSize: integer("file_size").notNull(),
    status: text("status").notNull().default("uploaded"),
    statusDetail: text("status_detail"),
    fieldMapping: jsonb("field_mapping")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, string>>(),
    corrections: jsonb("corrections")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    rowCount: integer("row_count").notNull().default(0),
    validCount: integer("valid_count").notNull().default(0),
    invalidCount: integer("invalid_count").notNull().default(0),
    ambiguousCount: integer("ambiguous_count").notNull().default(0),
    missingCount: integer("missing_count").notNull().default(0),
    operationGroupId: uuid("operation_group_id").references(
      () => aiOperationGroups.id,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("ai_import_sessions_recent_idx").on(t.tenantId, t.userId, t.createdAt),
  ],
);

export const aiImportRows = pgTable(
  "ai_import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    importSessionId: uuid("import_session_id")
      .notNull()
      .references(() => aiImportSessions.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(),
    /** valid | invalid | ambiguous | missing | ready | imported | failed | skipped */
    status: text("status").notNull(),
    /** create | update | skip | none */
    action: text("action").notNull().default("none"),
    raw: jsonb("raw")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, string>>(),
    normalised: jsonb("normalised")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    resolution: jsonb("resolution")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    errors: jsonb("errors")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<Array<Record<string, unknown>>>(),
    issues: jsonb("issues")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<Array<Record<string, unknown>>>(),
    operationId: uuid("operation_id").references(() => aiOperations.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("ai_import_rows_session_idx").on(t.importSessionId, t.rowIndex),
    index("ai_import_rows_tenant_status_idx").on(
      t.tenantId,
      t.importSessionId,
      t.status,
    ),
  ],
);

export type AiImportSessionRow = typeof aiImportSessions.$inferSelect;
export type AiImportRowRow = typeof aiImportRows.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Inventory Count (جرد)
//
// Storo has NO branches — these tables carry `tenant_id` only. Reconciliation
// math at confirm time reads movements from `product_history` (the single
// source of truth for every quantity change), computes:
//   adjustment = (counted_qty + Σ movements after counted_at) − current_qty
// and applies it via the shared `_applyAdjustment` helper in catalog.ts, so
// counts share one ledger with every other stock-mutating operation.
// ─────────────────────────────────────────────────────────────────────────────

export const inventoryCounts = pgTable(
  "inventory_counts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 'all' | 'category' | 'brand'. v1 scope kinds; v2 may add 'selected'. */
    scopeKind: text("scope_kind").notNull(),
    /** categoryId (uuid text) or brand (free text); null for 'all'. */
    scopeValue: text("scope_value"),
    /** 'draft' | 'in_progress' | 'review' | 'completed' | 'cancelled'. */
    status: text("status").notNull().default("draft"),
    /** Cached size of the frozen scope — the baseline-row count. Denominator
     *  of the progress indicator; added-mid-count rows don't inflate it. */
    scopeProductCount: integer("scope_product_count").notNull().default(0),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** `UNIQUE (tenant_id, confirm_idempotency_key)` — a replayed confirm with
     *  the same key collides and the handler returns the stored result. */
    confirmIdempotencyKey: text("confirm_idempotency_key"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("inventory_counts_idem_uq")
      .on(t.tenantId, t.confirmIdempotencyKey)
      .where(sql`confirm_idempotency_key IS NOT NULL`),
    index("inventory_counts_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
  ],
);

export const inventoryCountLines = pgTable(
  "inventory_count_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    countId: uuid("count_id")
      .notNull()
      .references(() => inventoryCounts.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    /** Frozen at line creation — either the bulk-insert at count creation
     *  (scope baseline) or the moment an out-of-scope product was added. */
    baselineQty: integer("baseline_qty").notNull(),
    /** Null until the shopkeeper actually enters a physical count. */
    countedQty: integer("counted_qty"),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    countedByUserId: uuid("counted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 'scan' | 'manual'; null until counted. */
    source: text("source"),
    /** True when this product was added mid-count (not in the frozen scope). */
    addedMidCount: boolean("added_mid_count").notNull().default(false),
    /** Set by the confirm preflight; a true value blocks the confirm with
     *  409 COUNT_HAS_INVALID_LINES until the owner resolves it. */
    productMissingAtConfirm: boolean("product_missing_at_confirm")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("inventory_count_lines_count_product_uq").on(t.countId, t.productId),
    index("inventory_count_lines_count_idx").on(t.countId),
  ],
);

export const inventoryCountReconciliations = pgTable(
  "inventory_count_reconciliations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    countId: uuid("count_id")
      .notNull()
      .references(() => inventoryCounts.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    baselineQty: integer("baseline_qty").notNull(),
    countedQty: integer("counted_qty").notNull(),
    countedAt: timestamp("counted_at", { withTimezone: true }).notNull(),
    movementAfterCount: integer("movement_after_count").notNull(),
    currentQtyAtConfirm: integer("current_qty_at_confirm").notNull(),
    expectedPhysical: integer("expected_physical").notNull(),
    adjustment: integer("adjustment").notNull(),
    /** FK into product_history — the exact row this confirm wrote. Null when
     *  adjustment = 0 (no history row needed). */
    productHistoryId: uuid("product_history_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("inventory_count_recon_count_product_uq").on(t.countId, t.productId),
    index("inventory_count_recon_tenant_count_idx").on(t.tenantId, t.countId),
  ],
);

export type InventoryCountRow = typeof inventoryCounts.$inferSelect;
export type InventoryCountLineRow = typeof inventoryCountLines.$inferSelect;
export type InventoryCountReconciliationRow =
  typeof inventoryCountReconciliations.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Real-time presence (web).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * web_live_sessions — one row per web user with an active browser session,
 * refreshed on every authenticated request through
 * `requireTenant()` → `touchHeartbeat()` with a 60-second throttle.
 *
 * Primary key on user_id (NOT session_token) because the presence rollup
 * counts distinct users, and because NextAuth may rotate `session_token`.
 * Multiple browsers for the same user coalesce into one row — correct for
 * "online users", intentional for the KPI.
 *
 * Mobile presence lives in `auth_devices.last_used_at`; this table covers
 * web only. The admin SQL unions both for the headline count.
 *
 * No branch column: presence is tenant-scoped (Storo has no branches).
 */
export const webLiveSessions = pgTable(
  "web_live_sessions",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 'web' for a recognised browser UA, 'other' for anything the parser
     *  cannot classify. Analytics metadata only — never used for authz. */
    platform: text("platform").notNull().default("web"),
    userAgent: text("user_agent"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("web_live_sessions_tenant_idx").on(t.tenantId, t.lastActivityAt.desc()),
    index("web_live_sessions_activity_idx").on(t.lastActivityAt.desc()),
  ],
);

export type WebLiveSessionRow = typeof webLiveSessions.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Financial Management — migration 0064 (Slice 1)
//
// Hierarchical categories + money_movements table. The engine (lib/finance/pnl.ts)
// reads these alongside sales/returns/expenses/payroll to assemble the P&L.
// Sales/returns/expenses/payroll remain authoritative for their own domains —
// these tables are additive, not a parallel source of truth.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two-level category tree. System seeds live with tenant_id=NULL and are
 * visible to every tenant; custom categories carry a real tenant_id.
 * `kind` decides which P&L bucket the category sits in.
 */
export const financialCategories = pgTable(
  "financial_categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** NULL = system default visible to every tenant; set = tenant custom. */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    /** Two-level only — subcategory.parent_id points at its group row. */
    parentId: uuid("parent_id"),
    /** Stable identifier for seeded rows; makes re-running the seed safe. */
    slug: text("slug").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar").notNull(),
    /** 'opex' | 'other_income' | 'other_expense' */
    kind: text("kind").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    // System slug uniqueness + tenant slug uniqueness are expressed as
    // partial indexes in the SQL migration. Plain indexes here are enough
    // for Drizzle's introspection; the partials still exist in the DB.
    index("financial_categories_tenant_parent_idx").on(t.tenantId, t.parentId),
    index("financial_categories_parent_idx").on(t.parentId),
  ],
);

export type FinancialCategoryRow = typeof financialCategories.$inferSelect;

/**
 * Non-P&L cash movements. Explicitly EXCLUDED from every revenue/expense/
 * profit aggregation so an owner draw doesn't masquerade as an operating
 * expense (and so forth).
 */
export const moneyMovements = pgTable(
  "money_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    /** One of: owner_deposit | owner_withdrawal | cash_transfer | loan_received
     *  | loan_principal_repayment | supplier_payment_direct | customer_deposit | other */
    kind: text("kind").notNull(),
    amount: text("amount").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),
    description: text("description"),
    paymentMethod: text("payment_method"),
    /** Soft reference back to the settled entity (no FK — a deleted supplier
     *  must not tear the ledger). */
    relatedEntityType: text("related_entity_type"),
    relatedEntityId: uuid("related_entity_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("money_movements_tenant_date_idx").on(t.tenantId, t.occurredAt),
    index("money_movements_tenant_kind_idx").on(t.tenantId, t.kind),
  ],
);

export type MoneyMovementRow = typeof moneyMovements.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Notification Center & Automation — three new tables. See
// lib/db/migrations/0069_notification_center.sql for the detailed intent.
// Nothing in this block changes existing notification_preferences semantics;
// the 3-level resolver reads tenant_notification_overrides after user prefs.
// ─────────────────────────────────────────────────────────────────────────────

export const tenantNotificationOverrides = pgTable(
  "tenant_notification_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    enabled: boolean("enabled").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("tenant_notification_overrides_tenant_event_unique").on(
      t.tenantId,
      t.eventType,
    ),
    index("tenant_notification_overrides_tenant_idx").on(t.tenantId),
  ],
);

export type TenantNotificationOverrideRow =
  typeof tenantNotificationOverrides.$inferSelect;

export const tenantReportSettings = pgTable(
  "tenant_report_settings",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    dailyEnabled: boolean("daily_enabled").notNull().default(true),
    dailyHour: integer("daily_hour").notNull().default(21),
    dailyMinute: integer("daily_minute").notNull().default(0),
    weeklyEnabled: boolean("weekly_enabled").notNull().default(true),
    weeklyDow: integer("weekly_dow").notNull().default(0), // 0=Sun
    weeklyHour: integer("weekly_hour").notNull().default(9),
    weeklyMinute: integer("weekly_minute").notNull().default(0),
    monthlyEnabled: boolean("monthly_enabled").notNull().default(true),
    monthlyDay: integer("monthly_day").notNull().default(1), // 1..28
    monthlyHour: integer("monthly_hour").notNull().default(9),
    monthlyMinute: integer("monthly_minute").notNull().default(0),
    recipients: uuid("recipients")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
);

export type TenantReportSettingsRow = typeof tenantReportSettings.$inferSelect;

export const employeeSchedules = pgTable(
  "employee_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shiftStart: time("shift_start").notNull(),
    shiftEnd: time("shift_end").notNull(),
    /** Bitmask: bit 0 = Sun … bit 6 = Sat. 125 = 0b1111101 (Fri off, Egyptian default). */
    workDays: smallint("work_days").notNull().default(125),
    /** -1 = inherit tenant default (attendance_settings.grace_minutes_late). */
    graceMinutes: integer("grace_minutes").notNull().default(-1),
    enabled: boolean("enabled").notNull().default(true),
    timezoneOverride: text("timezone_override"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("employee_schedules_tenant_user_unique").on(t.tenantId, t.userId),
    index("employee_schedules_tenant_idx").on(t.tenantId),
  ],
);

export type EmployeeScheduleRow = typeof employeeSchedules.$inferSelect;
