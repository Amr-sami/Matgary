// Constants and types for the activity log that need to be importable from
// both client and server. Keep this file free of any DB / Node-only imports
// so it can be bundled into client components.

export type ActivityCategory =
  | "auth"
  | "team"
  | "settings"
  | "leave"
  | "task"
  | "product"
  | "sale"
  | "expense"
  | "supplier"
  | "purchase"
  | "attendance";

export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  "auth",
  "team",
  "settings",
  "leave",
  "task",
  "product",
  "sale",
  "expense",
  "supplier",
  "purchase",
  "attendance",
];

// Arabic labels for known actions. The page renders the raw key when missing,
// so adding a new action without updating this map is harmless.
//
// React components on the new i18n path prefer `dict.app.activityLabels.actions`
// (sourced from the dictionary). This constant stays as a back-compat fallback
// for non-React callers (logs, exports, server-side renderers).
export const ACTION_LABELS: Record<string, string> = {
  "auth.login": "تسجيل الدخول",
  "auth.2fa_enable": "تفعيل المصادقة الثنائية",
  "auth.2fa_disable": "تعطيل المصادقة الثنائية",
  "auth.recovery_codes_regenerated": "تجديد الرموز الاحتياطية",
  "auth.session_revoke_all": "تسجيل خروج من جميع الأجهزة",
  "auth.data_export": "تنزيل نسخة من بيانات المتجر",
  "tenant.deletion_scheduled": "تحديد موعد حذف المتجر",
  "tenant.deletion_cancelled": "إلغاء حذف المتجر",
  "auth.logout": "تسجيل الخروج",
  "auth.password_change": "تغيير كلمة المرور",
  "team.add": "إضافة موظف",
  "team.update": "تعديل بيانات موظف",
  "team.delete": "حذف موظف",
  "team.password_reset": "إعادة ضبط كلمة مرور موظف",
  "team.compensation_set": "تعديل راتب / أجر موظف",
  "settings.update": "تعديل إعدادات المتجر",
  "settings.attendance_update": "تعديل إعدادات الحضور",
  "leave.submit": "تقديم طلب إجازة",
  "leave.approve": "الموافقة على إجازة",
  "leave.reject": "رفض إجازة",
  "task.create": "إنشاء مهمة",
  "task.update": "تعديل مهمة",
  "task.delete": "حذف مهمة",
  "product.create": "إضافة منتج",
  "product.update": "تعديل منتج",
  "product.delete": "حذف منتج",
  "product.adjust": "تعديل مخزون",
  "sale.create": "تسجيل فاتورة",
  "sale.update": "تعديل فاتورة",
  "sale.void": "إلغاء فاتورة",
  "sale.mark_paid": "تأكيد دفع فاتورة",
  "expense.create": "تسجيل مصروف",
  "expense.delete": "حذف مصروف",
  "expense.recurring_materialized": "إنشاء مصاريف دورية مستحقة",
  "supplier.create": "إضافة مورد",
  "supplier.update": "تعديل مورد",
  "supplier.delete": "حذف مورد",
  "purchase.create": "إنشاء أمر شراء",
  "purchase.receive": "استلام أمر شراء",
  "purchase.cancel": "إلغاء أمر شراء",
  "attendance.check_in": "تسجيل دخول",
  "attendance.check_out": "تسجيل خروج",
  "attendance.geofence_rejected": "محاولة حضور من خارج نطاق المتجر",
  "billing.checkout_started": "فتح صفحة الدفع",
  "billing.payment_succeeded": "تم استلام دفعة الاشتراك",
  "billing.payment_failed": "فشل دفع الاشتراك",
  "billing.cancelled": "إلغاء الاشتراك",
  "loyalty.credit_grant": "إضافة رصيد للعميل",
  "loyalty.credit_deduct": "خصم رصيد من العميل",
  "branch.create": "إضافة فرع",
  "branch.update": "تعديل فرع",
  "branch.disable": "إيقاف فرع",
  "branch.enable": "تفعيل فرع",
  "branch.delete": "حذف فرع",
  "branch.switch": "تبديل الفرع الحالي",
};

// Arabic back-compat label for a metadata field key. The locale-aware path
// in `formatActivityDetails` reads from `copy.fields` / `copy.fieldNames`
// when callers pass a dict-driven copy bundle.
const FIELD_LABELS_AR: Record<string, string> = {
  username: "اسم المستخدم",
  permissions: "الصلاحيات",
  changed: "الحقول المعدلة",
  payType: "نوع الراتب",
  baseSalaryMonthly: "الراتب الشهري",
  hourlyRate: "أجر الساعة",
  invoiceId: "رقم الفاتورة",
  lineCount: "عدد الأصناف",
  totalQuantity: "إجمالي القطع",
  paymentMethod: "طريقة الدفع",
  productId: "المنتج",
  quantitySold: "الكمية",
  pricePerUnit: "السعر",
  quantity: "الكمية",
  price: "السعر",
  delta: "التغيير",
  newQuantity: "الرصيد الجديد",
  amount: "المبلغ",
  category: "الفئة",
  startDate: "من",
  endDate: "إلى",
  note: "ملاحظة",
  type: "النوع",
  source: "الطريقة",
  latitude: "خط العرض",
  longitude: "خط الطول",
  accuracyM: "دقة الموقع (متر)",
};

const FIELD_NAME_LABELS_AR: Record<string, string> = {
  shopName: "اسم المتجر",
  shopPhone: "هاتف المتجر",
  logoPath: "شعار المتجر",
  messageTemplate: "نص رسالة WhatsApp",
  greenApiEnabled: "تفعيل Green API",
  greenApiInstanceId: "معرّف الـ Instance",
  greenApiUrl: "رابط الخدمة",
  whatsappCloudEnabled: "تفعيل WhatsApp Cloud API",
  whatsappCloudPhoneId: "Phone Number ID",
  whatsappCloudBusinessId: "WhatsApp Business Account ID",
  sendAsPdf: "إرسال كـ PDF",
  autoOpenWhatsApp: "فتح WhatsApp تلقائياً",
  workHoursPerDay: "ساعات العمل اليومية",
  weekendDays: "أيام الإجازة الأسبوعية",
  overtimeMultiplier: "معدل الأوفر",
  graceMinutesLate: "دقائق التأخير المسموحة",
  displayName: "الاسم الظاهر",
  phone: "الهاتف",
  nationalId: "الرقم القومي",
  address: "العنوان",
  profilePhotoPath: "صورة شخصية",
  idPhotoPath: "صورة البطاقة",
  brand: "البراند",
  costPrice: "سعر الشراء",
  lowStockThreshold: "حد التنبيه للمخزون",
  sku: "الكود (SKU)",
  tags: "وسوم",
  supplier: "المورد",
  supplierId: "المورد",
  location: "موقع التخزين",
};

const PAY_METHOD_LABELS_AR: Record<string, string> = {
  cash: "نقدي",
  instapay: "إنستاباي",
  card: "كارت",
  deferred: "آجل",
};

const PAY_TYPE_LABELS_AR: Record<string, string> = {
  fixed: "ثابت",
  hourly: "بالساعة",
  hybrid: "مختلط",
};

const ATTENDANCE_TYPE_LABELS_AR: Record<string, string> = {
  check_in: "تسجيل دخول",
  check_out: "تسجيل خروج",
};

const ATTENDANCE_SOURCE_LABELS_AR: Record<string, string> = {
  manual: "يدوي",
  geofence: "تلقائي بالموقع",
  qr: "QR",
  manager_attest: "إثبات مدير",
};

const EXPENSE_CATEGORY_LABELS_AR: Record<string, string> = {
  rent: "إيجار",
  salaries: "رواتب",
  electricity: "كهرباء",
  water: "مياه",
  internet: "إنترنت",
  supplier: "مورد",
  other: "أخرى",
};

export interface ActivityDetail {
  label: string;
  value: string;
}

/**
 * Copy bundle sourced from the dictionary. React callers pass this; legacy
 * callers omit it and get the Arabic constants above.
 */
export interface ActivityCopy {
  fields: Record<string, string>;
  fieldNames: Record<string, string>;
  paymentMethods: Record<string, string>;
  payTypes: Record<string, string>;
  attendanceTypes: Record<string, string>;
  attendanceSources: Record<string, string>;
  expenseCategories: Record<string, string>;
  /** Template like `"±{n} م"` / `"±{n}m"` */
  accuracySuffix: string;
}

const AR_FALLBACK: ActivityCopy = {
  fields: FIELD_LABELS_AR,
  fieldNames: FIELD_NAME_LABELS_AR,
  paymentMethods: PAY_METHOD_LABELS_AR,
  payTypes: PAY_TYPE_LABELS_AR,
  attendanceTypes: ATTENDANCE_TYPE_LABELS_AR,
  attendanceSources: ATTENDANCE_SOURCE_LABELS_AR,
  expenseCategories: EXPENSE_CATEGORY_LABELS_AR,
  accuracySuffix: "±{n} م",
};

function formatNumber(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
  return v.toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });
}

function formatDateValue(v: unknown): string {
  if (typeof v !== "string") return String(v);
  const d = new Date(v);
  if (!Number.isFinite(d.valueOf())) return v;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function listOfChangedFields(keys: unknown, copy: ActivityCopy): string {
  if (!Array.isArray(keys)) return String(keys);
  return keys
    .map((k) => copy.fieldNames[String(k)] ?? copy.fields[String(k)] ?? String(k))
    .join(" • ");
}

/**
 * Translate the metadata blob attached to an activity row into a small list
 * of "label: value" pairs the owner can actually read. Returns an empty array
 * when there's nothing meaningful to show.
 *
 * Pass `copy` from the dictionary when calling from React (preferred). When
 * omitted, falls back to the Arabic labels so non-React callers keep working.
 */
export function formatActivityDetails(
  action: string,
  metadata: Record<string, unknown> | null | undefined,
  copy: ActivityCopy = AR_FALLBACK,
): ActivityDetail[] {
  if (!metadata) return [];
  const out: ActivityDetail[] = [];
  const m = metadata;
  const f = copy.fields;

  switch (action) {
    case "sale.create": {
      if (m.invoiceId) out.push({ label: f.invoiceId, value: String(m.invoiceId) });
      if (Array.isArray(m.lines) && m.lines.length > 0) {
        const lines = m.lines as Array<{
          productName?: unknown;
          quantity?: unknown;
          pricePerUnit?: unknown;
          lineTotal?: unknown;
        }>;
        const summary = lines
          .map((l) => {
            const name = l.productName ? String(l.productName) : "—";
            const qty = typeof l.quantity === "number" ? l.quantity : null;
            const price =
              typeof l.pricePerUnit === "number" ? l.pricePerUnit : null;
            if (qty != null && price != null)
              return `${name} (${formatNumber(qty)} × ${formatNumber(price)})`;
            if (qty != null) return `${name} (${formatNumber(qty)})`;
            return name;
          })
          .join("، ");
        out.push({ label: f.lines, value: summary });
      }
      if (typeof m.totalQuantity === "number")
        out.push({ label: f.totalQuantity, value: formatNumber(m.totalQuantity) });
      if (typeof m.total === "number")
        out.push({ label: f.total, value: formatNumber(m.total) });
      if (typeof m.quantitySold === "number")
        out.push({ label: f.quantitySold, value: formatNumber(m.quantitySold) });
      if (typeof m.pricePerUnit === "number")
        out.push({ label: f.pricePerUnit, value: formatNumber(m.pricePerUnit) });
      if (m.paymentMethod)
        out.push({
          label: f.paymentMethod,
          value: copy.paymentMethods[String(m.paymentMethod)] ?? String(m.paymentMethod),
        });
      if (m.customerName)
        out.push({ label: f.customerName, value: String(m.customerName) });
      if (m.customerPhone)
        out.push({ label: f.customerPhone, value: String(m.customerPhone) });
      if (m.note) out.push({ label: f.note, value: String(m.note) });
      return out;
    }
    case "attendance.check_in":
    case "attendance.check_out": {
      if (m.source)
        out.push({
          label: f.source,
          value: copy.attendanceSources[String(m.source)] ?? String(m.source),
        });
      return out;
    }
    case "attendance.geofence_rejected": {
      if (m.type)
        out.push({
          label: f.attemptType,
          value: copy.attendanceTypes[String(m.type)] ?? String(m.type),
        });
      if (typeof m.latitude === "number" && typeof m.longitude === "number") {
        const lat = m.latitude.toFixed(6);
        const lng = m.longitude.toFixed(6);
        out.push({ label: f.loggedLocation, value: `${lat}, ${lng}` });
      }
      if (typeof m.accuracyM === "number")
        out.push({
          label: f.locationAccuracy,
          value: copy.accuracySuffix.replace("{n}", formatNumber(m.accuracyM)),
        });
      return out;
    }
    case "team.add": {
      if (m.username) out.push({ label: f.username, value: String(m.username) });
      if (Array.isArray(m.permissions))
        out.push({
          label: f.permissionsCount,
          value: formatNumber(m.permissions.length),
        });
      return out;
    }
    case "team.update":
    case "product.update":
    case "settings.update":
    case "settings.attendance_update": {
      if (Array.isArray(m.changed) && m.changed.length > 0)
        out.push({ label: f.changed, value: listOfChangedFields(m.changed, copy) });
      return out;
    }
    case "team.compensation_set": {
      if (m.payType)
        out.push({
          label: f.payType,
          value: copy.payTypes[String(m.payType)] ?? String(m.payType),
        });
      if (m.baseSalaryMonthly != null)
        out.push({
          label: f.baseSalaryMonthly,
          value: formatNumber(m.baseSalaryMonthly),
        });
      if (m.hourlyRate != null)
        out.push({ label: f.hourlyRate, value: formatNumber(m.hourlyRate) });
      return out;
    }
    case "product.create": {
      if (typeof m.quantity === "number")
        out.push({ label: f.initialQuantity, value: formatNumber(m.quantity) });
      if (typeof m.price === "number")
        out.push({ label: f.price, value: formatNumber(m.price) });
      return out;
    }
    case "product.adjust": {
      if (typeof m.delta === "number") {
        const sign = m.delta > 0 ? "+" : "";
        out.push({ label: f.delta, value: `${sign}${formatNumber(m.delta)}` });
      }
      if (typeof m.newQuantity === "number")
        out.push({ label: f.newQuantity, value: formatNumber(m.newQuantity) });
      return out;
    }
    case "expense.create": {
      if (typeof m.amount === "number")
        out.push({ label: f.amount, value: formatNumber(m.amount) });
      if (m.category)
        out.push({
          label: f.type,
          value: copy.expenseCategories[String(m.category)] ?? String(m.category),
        });
      return out;
    }
    case "leave.submit": {
      if (m.startDate) out.push({ label: f.startDate, value: formatDateValue(m.startDate) });
      if (m.endDate) out.push({ label: f.endDate, value: formatDateValue(m.endDate) });
      return out;
    }
    case "leave.approve":
    case "leave.reject": {
      if (m.note) out.push({ label: f.note, value: String(m.note) });
      return out;
    }
    default:
      // Generic best-effort: expose any keys we know how to label.
      for (const [k, v] of Object.entries(m)) {
        if (v == null || v === "") continue;
        const label = copy.fields[k] ?? copy.fieldNames[k];
        if (!label) continue;
        out.push({
          label,
          value: typeof v === "object" ? JSON.stringify(v) : String(v),
        });
      }
      return out;
  }
}

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  auth: "الحساب",
  team: "الموظفون",
  settings: "الإعدادات",
  leave: "الإجازات",
  task: "المهام",
  product: "المنتجات",
  sale: "المبيعات",
  expense: "المصاريف",
  supplier: "الموردون",
  purchase: "المشتريات",
  attendance: "الحضور",
};
