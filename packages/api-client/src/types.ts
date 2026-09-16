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
  };
  tenant: {
    id: string;
    slug: string | null;
    name: string | null;
    subscriptionStatus: string | null;
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
