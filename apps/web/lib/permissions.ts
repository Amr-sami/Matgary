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
  // Inventory count (جرد): separate from manage_inventory so an owner can
  // grant a trusted stock-taker the counting flow without exposing the
  // product editor. view_ lets them open the count/report screens; manage_
  // lets them create, enter lines, cancel, and confirm (writes to the
  // ledger). Reports are gated by view_.
  | "view_inventory_counts"
  | "manage_inventory_counts"
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
  // Payroll V1 — gate for the payroll register, adjustments, finalize/void,
  // and compensation edits. Separate from `manage_team` so a store manager
  // can be given team edit rights without exposing finalized sheets or the
  // ability to post monthly bonuses/deductions.
  | "manage_payroll"
  // Tasks (every staffer can see their own; manage allows assigning to others)
  | "manage_tasks"
  // Leave requests
  | "request_leave" // staff submit own
  | "manage_leave" // approve / reject everyone's
  // Audit / activity log
  | "view_activity_log" // see "who did what" feed (owner-only by default)
  // Daily owner digest
  | "manage_digest_settings" // owner: toggle, recipients, schedule
  // Digital collections (InstaPay + mobile wallets). Enforced from day one
  // (requirePermissionWithBranchEnforced), never in DEFAULT_STAFF_PERMISSIONS.
  | "view_collections" // inbox, daily totals, credits
  | "confirm_collections" // confirm / reject / match / ignore / paste (four-eyes)
  | "manage_collection_accounts" // receiving accounts, collections settings, ingest devices
  // Notification override — NOT an authorization bypass. A user with this
  // permission ignores their personal per-event preference rows and receives
  // every event they are already ELIGIBLE for (by role + event's recipient
  // rules). Tenant isolation, EVENT_RECIPIENT_ROLES, EVENT_RECIPIENT_PERMISSION
  // and the walls still gate everything else.
  | "receive_all_alerts"
  // ── Financial Management (Slice 1, migration 0064) ────────────────────────
  // `view_financials` is the gate for the Financials section (Insights →
  // Financials) + the engine's read APIs. `view_profit` can be denied
  // separately if a shop manager should see expense totals but not margin.
  // `manage_*` gate writes to the hierarchical category tree, recurring
  // expense templates, and the new money_movements table respectively.
  | "view_financials"
  | "view_profit"
  | "manage_expense_categories"
  | "manage_recurring_expenses"
  | "manage_money_movements";

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
  "view_inventory_counts",
  "manage_inventory_counts",
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
  "manage_payroll",
  "manage_tasks",
  "request_leave",
  "manage_leave",
  "view_activity_log",
  "manage_digest_settings",
  "view_collections",
  "confirm_collections",
  "manage_collection_accounts",
  "receive_all_alerts",
  "view_financials",
  "view_profit",
  "manage_expense_categories",
  "manage_recurring_expenses",
  "manage_money_movements",
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
  view_inventory_counts: "عرض جرد المخزون",
  manage_inventory_counts: "إجراء جرد المخزون (عدّ / اعتماد)",
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
  manage_payroll: "إدارة الرواتب (حساب / اعتماد / تسويات)",
  manage_tasks: "إنشاء وتوزيع المهام",
  request_leave: "تقديم طلبات إجازة",
  manage_leave: "الموافقة على طلبات الإجازة",
  view_activity_log: "عرض سجل النشاط",
  manage_digest_settings: "إعدادات الملخص اليومي",
  view_collections: "عرض التحويلات",
  confirm_collections: "تأكيد ورفض التحويلات",
  manage_collection_accounts: "إدارة حسابات الاستلام",
  receive_all_alerts: "استقبال كل الإشعارات",
  view_financials: "عرض الماليات",
  view_profit: "عرض الأرباح",
  manage_expense_categories: "إدارة أقسام المصاريف",
  manage_recurring_expenses: "إدارة المصاريف الدورية",
  manage_money_movements: "إدارة الحركات المالية",
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
    title: "جرد المخزون",
    permissions: ["view_inventory_counts", "manage_inventory_counts"],
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
    title: "الرواتب",
    permissions: ["manage_payroll"],
  },
  {
    title: "الملخص اليومي",
    permissions: ["manage_digest_settings"],
  },
  {
    title: "الإشعارات",
    permissions: ["receive_all_alerts"],
  },
  {
    title: "التحويلات",
    permissions: ["view_collections", "confirm_collections", "manage_collection_accounts"],
  },
  {
    title: "الماليات",
    permissions: [
      "view_financials",
      "view_profit",
      "manage_expense_categories",
      "manage_recurring_expenses",
      "manage_money_movements",
    ],
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
