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
  | "view_suppliers"
  | "view_purchases"
  // Action capabilities
  | "manage_inventory" // add / edit / delete products + adjust stock
  | "record_sales" // create new sales (POS flow)
  | "modify_sales" // edit / void existing sales
  | "manage_returns"
  | "manage_expenses"
  | "manage_catalog" // categories / attributes / brands editor
  | "manage_suppliers" // create/edit/delete suppliers
  | "manage_purchases" // create/receive/cancel purchase orders
  | "manage_whatsapp" // shop settings + WhatsApp creds
  | "manage_team" // owner-only in practice — invite / remove employees
  // Attendance & payroll
  | "attendance_self_manual" // staff may record own check-in/out manually
  // Tasks (every staffer can see their own; manage allows assigning to others)
  | "manage_tasks"
  // Leave requests
  | "request_leave" // staff submit own
  | "manage_leave" // approve / reject everyone's
  // Audit / activity log
  | "view_activity_log" // see "who did what" feed (owner-only by default)
  // Daily owner digest
  | "manage_digest_settings"; // owner: toggle, recipients, schedule

export const ALL_PERMISSIONS: Permission[] = [
  "view_dashboard",
  "view_inventory",
  "view_sales",
  "view_customers",
  "view_expenses",
  "view_returns",
  "view_insights",
  "view_settings",
  "view_suppliers",
  "view_purchases",
  "manage_inventory",
  "record_sales",
  "modify_sales",
  "manage_returns",
  "manage_expenses",
  "manage_catalog",
  "manage_suppliers",
  "manage_purchases",
  "manage_whatsapp",
  "manage_team",
  "attendance_self_manual",
  "manage_tasks",
  "request_leave",
  "manage_leave",
  "view_activity_log",
  "manage_digest_settings",
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
  view_suppliers: "الموردين",
  view_purchases: "المشتريات",
  manage_inventory: "إدارة المنتجات (إضافة / تعديل / حذف)",
  record_sales: "تسجيل المبيعات",
  modify_sales: "تعديل / إلغاء فاتورة",
  manage_returns: "تسجيل المرتجعات",
  manage_expenses: "إدارة المصاريف",
  manage_catalog: "إدارة الأقسام والبراندات",
  manage_suppliers: "إدارة الموردين",
  manage_purchases: "إدارة المشتريات (إنشاء / استلام)",
  manage_whatsapp: "إعدادات المتجر و WhatsApp",
  manage_team: "إدارة الموظفين",
  attendance_self_manual: "تسجيل الحضور يدوياً",
  manage_tasks: "إنشاء وتوزيع المهام",
  request_leave: "تقديم طلبات إجازة",
  manage_leave: "الموافقة على طلبات الإجازة",
  view_activity_log: "عرض سجل النشاط",
  manage_digest_settings: "إعدادات الملخص اليومي",
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
      "view_suppliers",
      "view_purchases",
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
  {
    title: "الموردين والمشتريات",
    permissions: ["manage_suppliers", "manage_purchases"],
  },
  {
    title: "المهام والإجازات",
    permissions: ["manage_tasks", "request_leave", "manage_leave"],
  },
  {
    title: "المراقبة والتدقيق",
    permissions: ["view_activity_log"],
  },
  {
    title: "الحضور والانصراف",
    permissions: ["attendance_self_manual"],
  },
  {
    title: "الملخص اليومي",
    permissions: ["manage_digest_settings"],
  },
];

// Sensible default for a new "cashier" employee — can use the POS, see
// inventory, but cannot edit anything structural. Every employee gets the
// ability to submit leave requests by default.
export const DEFAULT_STAFF_PERMISSIONS: Permission[] = [
  "view_dashboard",
  "view_inventory",
  "view_sales",
  "view_customers",
  "record_sales",
  "request_leave",
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
