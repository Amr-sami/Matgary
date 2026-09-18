/**
 * Response DTOs for /api/v1.
 *
 * Hand-written and mirrored from the route handlers until the backend emits an
 * OpenAPI document (doc 01 §7). Each type names the file it was read from, so a
 * drift is a grep away.
 */

/** apps/web/app/api/v1/auth/login/route.ts */
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  /** Seconds. The client converts this to an absolute expiry itself. */
  expiresIn: number;
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    /** The RAW column — empty for an owner. Use /me for the effective set. */
    permissions: string[];
    locale: string;
  };
  tenant: {
    id: string;
    slug: string | null;
    suspended: boolean;
    subscriptionStatus: string | null;
    subscriptionAccessActive: boolean;
  };
  deviceId: string | null;
}

/** apps/web/app/api/v1/auth/refresh/route.ts */
export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId: string;
}

export interface BranchSummary {
  id: string;
  name: string;
  isPrimary: boolean;
}

/** apps/web/app/api/v1/me/route.ts */
export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    locale: string;
    /**
     * The account is behind the PASSWORD_CHANGE_REQUIRED wall: every request
     * but /me and the change-password call 403s until it is changed. /me is
     * the one read the server answers under the wall precisely so the app
     * can seed a session and route here. Optional: older servers omit it.
     */
    mustChangePassword?: boolean;
  };
  tenant: {
    id: string;
    slug: string | null;
    name: string | null;
    subscriptionStatus: string | null;
    /** False = SUBSCRIPTION_REQUIRED wall: only /me and /api/billing/me answer. */
    subscriptionAccessActive: boolean;
    suspended: boolean;
  };
  /** The branch the server resolved for this request. */
  branch: {
    id: string | null;
    name: string | null;
    isPrimary: boolean;
  };
  /** Active branches this user may switch to. Already filtered. */
  branches: BranchSummary[];
  /**
   * EFFECTIVE permissions — owner-expanded server-side. This is the array the
   * UI must build navigation from; `LoginResponse.user.permissions` is the raw
   * column and is empty for owners.
   */
  permissions: string[];
  isOwner: boolean;
  /**
   * False until the onboarding wizard's Finish/Skip has run for the tenant
   * (shop_settings.shopName set) — the web's session.user.onboardingComplete.
   * The wizard is a soft gate: offer a way back to /onboarding while false.
   * Optional: older servers omit it.
   */
  onboardingComplete?: boolean;
}

/** apps/web/app/api/v1/auth/devices/route.ts */
export interface DeviceSummary {
  id: string;
  deviceName: string | null;
  platform: string | null;
  appVersion: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  /** True for the device making the call — never offer it a "revoke" button. */
  current: boolean;
}

/** apps/web/lib/repo/insights.ts — DashboardStats */
export interface DashboardStats {
  todayRevenue: number;
  monthRevenue: number;
  monthReturns: number;
  productCount: number;
}

export interface LowStockItem {
  id: string;
  name: string;
  sku: string | null;
  categoryId: string | null;
  brand: string | null;
  quantity: number;
  lowStockThreshold: number;
}

/** apps/web/app/api/v1/dashboard/route.ts */
export interface DashboardResponse {
  branch: {
    /** null when the caller asked for every branch (owner only). */
    id: string | null;
    allBranches: boolean;
    activeBranchId: string | null;
    activeBranchName: string | null;
    allowedBranchIds: string[];
  };
  stats: DashboardStats;
  lowStock: {
    outOfStockCount: number;
    lowStockCount: number;
    /** True when `items` is clipped — show "view all", not "that's everything". */
    truncated: boolean;
    items: LowStockItem[];
  };
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// The existing web API. These routes predate /api/v1 and were never written for
// a native client — they work because every handler funnels through
// requireTenant/requirePermission, which learned bearer auth in Phase 0. They
// all answer `{ data, branchId }`.
// ---------------------------------------------------------------------------

/** Envelope shared by every list route under /api. */
export interface ListEnvelope<T> {
  data: T[];
  /** The branch the server resolved — echo of X-Branch-Id, or the default. */
  branchId?: string | null;
}

export interface Product {
  id: string;
  name: string;
  /** Category UUID, not a slug — join against listCategories(). */
  category: string;
  gender: string;
  attributes: Record<string, unknown>;
  brand: string | null;
  quantity: number;
  price: number;
  costPrice: number;
  lowStockThreshold: number;
  tags: string[];
  supplierId: string | null;
  sku?: string | null;
  barcode?: string | null;
  /** Relative photo URL (/api/uploads/product-image/…); null = none. Prefix with the API base. */
  imageUrl?: string | null;
  createdAt: string;
}

export interface SaleLine {
  id: string;
  invoiceId: string;
  productId: string;
  productName: string;
  category: string;
  gender: string;
  brand: string | null;
  quantitySold: number;
  pricePerUnit: number;
  costPrice?: number;
  totalPrice?: number;
  saleDate?: string;
  customerName?: string | null;
  customerPhone?: string | null;
  paymentMethod?: string | null;
}

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  supplierName: string;
  status: "draft" | "ordered" | "received" | "cancelled" | string;
  orderDate: string;
  receivedDate: string | null;
  notes: string | null;
  total: number;
  paidAmount: number;
  itemCount: number;
  createdAt: string;
}

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  /** Positive means money owed TO the supplier. */
  balance: number;
  createdAt: string;
}

export interface Expense {
  id: string;
  title: string;
  amount: number;
  category: string;
  supplierId: string | null;
  isRecurring: boolean;
  recurrencePeriod: string | null;
  date: string;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "done" | string;
  priority: "low" | "normal" | "high" | string;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Category {
  id: string;
  key: string;
  label: string;
  icon: string | null;
  position: number;
  hasAttributes: boolean;
}

export interface Brand {
  id: string;
  categoryId: string;
  name: string;
}

export interface ReturnRecord {
  id: string;
  invoiceId?: string | null;
  productName?: string;
  quantity?: number;
  amount?: number;
  returnDate?: string;
  reason?: string | null;
}

/** apps/web/app/api/v1/customers/route.ts — aggregated, not a table read. */
export interface CustomerSummary {
  phone: string;
  name: string | null;
  totalSpend: number;
  invoiceCount: number;
  lastPurchaseAt: string | null;
  /** Unpaid balance. Positive means the customer owes the shop. */
  outstanding: number;
  oldestUnpaidAt: string | null;
}

/** apps/web/app/api/team/route.ts */
export interface TeamMember {
  userId: string;
  loginEmail: string;
  username: string;
  displayName: string;
  role: string;
  permissions: string[];
  mustChangePassword?: boolean;
}
