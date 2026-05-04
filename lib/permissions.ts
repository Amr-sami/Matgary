// Permission catalog. The owner role implicitly has every permission;
// staff users have only the keys explicitly granted in tenant_members.permissions.

export type Permission =
  // Sidebar visibility
  | "view_dashboard"
  | "view_inventory"
  | "view_sales"
  | "view_customers"
  | "view_expenses"
  | "view_returns"
  | "view_insights"
  | "view_settings"
  // Action capabilities
  | "manage_inventory" // add / edit / delete products + adjust stock
  | "record_sales" // create new sales (POS flow)
  | "modify_sales" // edit / void existing sales
  | "manage_returns"
  | "manage_expenses"
  | "manage_catalog" // categories / attributes / brands editor
  | "manage_whatsapp" // shop settings + WhatsApp creds
  | "manage_team"; // owner-only in practice — invite / remove employees

export const ALL_PERMISSIONS: Permission[] = [
  "view_dashboard",
  "view_inventory",
  "view_sales",
  "view_customers",
  "view_expenses",
  "view_returns",
  "view_insights",
  "view_settings",
  "manage_inventory",
  "record_sales",
  "modify_sales",
  "manage_returns",
  "manage_expenses",
  "manage_catalog",
  "manage_whatsapp",
  "manage_team",
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  view_dashboard: "لوحة التحكم",
  view_inventory: "المخزن",
  view_sales: "المبيعات",
  view_customers: "العملاء",
  view_expenses: "المصاريف",
  view_returns: "المرتجعات",
  view_insights: "إحصائيات",
  view_settings: "الإعدادات",
  manage_inventory: "إدارة المنتجات (إضافة / تعديل / حذف)",
  record_sales: "تسجيل المبيعات",
  modify_sales: "تعديل / إلغاء فاتورة",
  manage_returns: "تسجيل المرتجعات",
  manage_expenses: "إدارة المصاريف",
  manage_catalog: "إدارة الأقسام والبراندات",
  manage_whatsapp: "إعدادات المتجر و WhatsApp",
  manage_team: "إدارة الموظفين",
};

export interface PermissionGroup {
  title: string;
  permissions: Permission[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    title: "الوصول للصفحات",
    permissions: [
      "view_dashboard",
      "view_inventory",
      "view_sales",
      "view_customers",
      "view_expenses",
      "view_returns",
      "view_insights",
      "view_settings",
    ],
  },
  {
    title: "صلاحيات التعديل",
    permissions: [
      "manage_inventory",
      "record_sales",
      "modify_sales",
      "manage_returns",
      "manage_expenses",
      "manage_catalog",
      "manage_whatsapp",
    ],
  },
];

// Sensible default for a new "cashier" employee — can use the POS, see
// inventory, but cannot edit anything structural.
export const DEFAULT_STAFF_PERMISSIONS: Permission[] = [
  "view_dashboard",
  "view_inventory",
  "view_sales",
  "view_customers",
  "record_sales",
];

export interface PermissionPrincipal {
  role: string | null;
  permissions: Permission[];
}

export function isOwner(p: PermissionPrincipal | null | undefined): boolean {
  return p?.role === "owner";
}

/** Owner has everything. Staff are limited to their explicit grants. */
export function can(
  principal: PermissionPrincipal | null | undefined,
  perm: Permission,
): boolean {
  if (!principal) return false;
  if (isOwner(principal)) return true;
  return principal.permissions.includes(perm);
}

export function canAny(
  principal: PermissionPrincipal | null | undefined,
  perms: Permission[],
): boolean {
  return perms.some((p) => can(principal, p));
}
