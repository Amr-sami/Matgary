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
export const ACTION_LABELS: Record<string, string> = {
  "auth.login": "تسجيل الدخول",
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

// Friendly Arabic label for a metadata field key. Falls back to the raw key
// when missing — the formatter then drops the row to avoid showing junk.
const FIELD_LABELS: Record<string, string> = {
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

const FIELD_NAME_LABELS: Record<string, string> = {
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

const PAY_METHOD_LABELS: Record<string, string> = {
  cash: "نقدي",
  instapay: "إنستاباي",
  card: "كارت",
  deferred: "آجل",
};

const PAY_TYPE_LABELS: Record<string, string> = {
  fixed: "ثابت",
  hourly: "بالساعة",
  hybrid: "مختلط",
};

const ATTENDANCE_TYPE_LABELS: Record<string, string> = {
  check_in: "تسجيل دخول",
  check_out: "تسجيل خروج",
};

const ATTENDANCE_SOURCE_LABELS: Record<string, string> = {
  manual: "يدوي",
  geofence: "تلقائي بالموقع",
  qr: "QR",
  manager_attest: "إثبات مدير",
};

const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
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

function formatNumber(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
  return v.toLocaleString("ar-EG", { maximumFractionDigits: 6 });
}

function formatDate(v: unknown): string {
  if (typeof v !== "string") return String(v);
  const d = new Date(v);
  if (!Number.isFinite(d.valueOf())) return v;
  return d.toLocaleDateString("ar-EG");
}

function listOfChangedFields(keys: unknown): string {
  if (!Array.isArray(keys)) return String(keys);
  return keys
    .map((k) => FIELD_NAME_LABELS[String(k)] ?? FIELD_LABELS[String(k)] ?? String(k))
    .join(" • ");
}

/**
 * Translate the metadata blob attached to an activity row into a small list
 * of "label: value" pairs the owner can actually read. Returns an empty array
 * when there's nothing meaningful to show.
 */
export function formatActivityDetails(
  action: string,
  metadata: Record<string, unknown> | null | undefined,
): ActivityDetail[] {
  if (!metadata) return [];
  const out: ActivityDetail[] = [];
  const m = metadata;

  switch (action) {
    case "sale.create": {
      if (m.invoiceId) out.push({ label: "رقم الفاتورة", value: String(m.invoiceId) });
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
        out.push({ label: "الأصناف", value: summary });
      }
      if (typeof m.totalQuantity === "number")
        out.push({ label: "إجمالي القطع", value: formatNumber(m.totalQuantity) });
      if (typeof m.total === "number")
        out.push({ label: "الإجمالي", value: formatNumber(m.total) });
      if (typeof m.quantitySold === "number")
        out.push({ label: "الكمية", value: formatNumber(m.quantitySold) });
      if (typeof m.pricePerUnit === "number")
        out.push({ label: "السعر", value: formatNumber(m.pricePerUnit) });
      if (m.paymentMethod)
        out.push({
          label: "طريقة الدفع",
          value: PAY_METHOD_LABELS[String(m.paymentMethod)] ?? String(m.paymentMethod),
        });
      if (m.customerName)
        out.push({ label: "اسم العميل", value: String(m.customerName) });
      if (m.customerPhone)
        out.push({ label: "هاتف العميل", value: String(m.customerPhone) });
      if (m.note) out.push({ label: "ملاحظة", value: String(m.note) });
      return out;
    }
    case "attendance.check_in":
    case "attendance.check_out": {
      if (m.source)
        out.push({
          label: "الطريقة",
          value: ATTENDANCE_SOURCE_LABELS[String(m.source)] ?? String(m.source),
        });
      return out;
    }
    case "attendance.geofence_rejected": {
      if (m.type)
        out.push({
          label: "نوع المحاولة",
          value: ATTENDANCE_TYPE_LABELS[String(m.type)] ?? String(m.type),
        });
      if (typeof m.latitude === "number" && typeof m.longitude === "number") {
        const lat = m.latitude.toFixed(6);
        const lng = m.longitude.toFixed(6);
        out.push({ label: "الموقع المسجَّل", value: `${lat}, ${lng}` });
      }
      if (typeof m.accuracyM === "number")
        out.push({ label: "دقة الموقع", value: `±${formatNumber(m.accuracyM)} م` });
      return out;
    }
    case "team.add": {
      if (m.username) out.push({ label: "اسم المستخدم", value: String(m.username) });
      if (Array.isArray(m.permissions))
        out.push({
          label: "عدد الصلاحيات",
          value: formatNumber(m.permissions.length),
        });
      return out;
    }
    case "team.update":
    case "product.update":
    case "settings.update":
    case "settings.attendance_update": {
      if (Array.isArray(m.changed) && m.changed.length > 0)
        out.push({ label: "الحقول المعدلة", value: listOfChangedFields(m.changed) });
      return out;
    }
    case "team.compensation_set": {
      if (m.payType)
        out.push({
          label: "نوع الراتب",
          value: PAY_TYPE_LABELS[String(m.payType)] ?? String(m.payType),
        });
      if (m.baseSalaryMonthly != null)
        out.push({
          label: "الراتب الشهري",
          value: formatNumber(m.baseSalaryMonthly),
        });
      if (m.hourlyRate != null)
        out.push({ label: "أجر الساعة", value: formatNumber(m.hourlyRate) });
      return out;
    }
    case "product.create": {
      if (typeof m.quantity === "number")
        out.push({ label: "الكمية الابتدائية", value: formatNumber(m.quantity) });
      if (typeof m.price === "number")
        out.push({ label: "السعر", value: formatNumber(m.price) });
      return out;
    }
    case "product.adjust": {
      if (typeof m.delta === "number") {
        const sign = m.delta > 0 ? "+" : "";
        out.push({ label: "التغيير", value: `${sign}${formatNumber(m.delta)}` });
      }
      if (typeof m.newQuantity === "number")
        out.push({ label: "الرصيد الجديد", value: formatNumber(m.newQuantity) });
      return out;
    }
    case "expense.create": {
      if (typeof m.amount === "number")
        out.push({ label: "المبلغ", value: formatNumber(m.amount) });
      if (m.category)
        out.push({
          label: "النوع",
          value: EXPENSE_CATEGORY_LABELS[String(m.category)] ?? String(m.category),
        });
      return out;
    }
    case "leave.submit": {
      if (m.startDate) out.push({ label: "من", value: formatDate(m.startDate) });
      if (m.endDate) out.push({ label: "إلى", value: formatDate(m.endDate) });
      return out;
    }
    case "leave.approve":
    case "leave.reject": {
      if (m.note) out.push({ label: "ملاحظة", value: String(m.note) });
      return out;
    }
    default:
      // Generic best-effort: expose any keys we know how to label.
      for (const [k, v] of Object.entries(m)) {
        if (v == null || v === "") continue;
        const label = FIELD_LABELS[k] ?? FIELD_NAME_LABELS[k];
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
