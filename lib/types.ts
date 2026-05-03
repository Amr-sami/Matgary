// Category and Gender are now per-tenant runtime data, not TS literals.
// `category` on a Product is a category id (uuid). Display labels come from
// useCategories().byId. The legacy `Gender` type is preserved as `string`
// so existing component code still compiles while we migrate Phase 2 callers.
export type Category = string;
export type Gender = string;

// Per-tenant category descriptor surfaced by useCategories().
export interface CategoryDescriptor {
  id: string;
  key: string;
  label: string;
  icon: string | null;
  position: number;
  hasAttributes: boolean;
}

// One attribute defined under a category (e.g. "gender" under "watches").
export interface CategoryAttribute {
  id: string;
  categoryId: string;
  key: string;
  label: string;
  position: number;
  required: boolean;
  values: CategoryAttributeValue[];
}

export interface CategoryAttributeValue {
  id: string;
  attributeId: string;
  key: string;
  label: string;
  position: number;
}

export interface BrandDescriptor {
  id: string;
  categoryId: string | null;
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY back-compat shims — present so unmigrated components keep compiling.
// New code MUST use useCategories().byId / product.attributes instead.
// These will be deleted at end of Phase 2/3 once every call site is updated.
// ─────────────────────────────────────────────────────────────────────────────
export const CATEGORY_LABELS: Record<string, string> = {};
export const GENDER_LABELS: Record<string, string> = {};
export const WATCH_BRANDS: string[] = ["Other"];

export interface Product {
  id: string;
  name: string;
  /** Category id (uuid). Use useCategories().byId[product.category] for the label. */
  category: Category;
  /** @deprecated Use `attributes.gender` (or whatever the category defines). Kept for migration compatibility. */
  gender: Gender;
  /** Snapshot of chosen attribute values, keyed by attribute key (e.g. { gender: "رجالي" }). */
  attributes?: Record<string, string>;
  brand?: string;
  quantity: number;
  price: number;
  costPrice?: number;
  lowStockThreshold: number;
  sku?: string;
  tags?: string[];
  supplier?: string;
  location?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DiscountType = "percentage" | "fixed";

export type PaymentMethod = "cash" | "instapay" | "card" | "deferred";

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "كاش",
  instapay: "انستاباي",
  card: "بطاقة",
  deferred: "آجل",
};

export interface Sale {
  id: string;
  invoiceId?: string;
  productId: string;
  productName: string;
  category: Category;
  gender: Gender;
  brand?: string;
  quantitySold: number;
  pricePerUnit: number;
  costPriceAtSale?: number;
  subtotal: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountAmount?: number;
  totalPrice: number;
  saleDate: Date;
  isReturned: boolean;
  returnedAt?: Date;
  returnedQuantity?: number;
  note?: string;
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: PaymentMethod;
  isPaid?: boolean;
  paidAt?: Date;
}

export interface CartLine {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType?: DiscountType;
  lineDiscountValue?: number;
}

export interface Return {
  id: string;
  saleId: string;
  productId: string;
  productName: string;
  returnedQuantity: number;
  returnDate: Date;
  reason: string;
}

export interface ProductFormData {
  step: 1 | 2 | 3;
  category: Category | null;
  gender: Gender | null;
  brand: string;
  customBrand: string;
  name: string;
  quantity: number;
  price: number;
  costPrice: number;
  lowStockThreshold: number;
  sku: string;
  tags: string;
  supplier: string;
  location: string;
}

export type ExpenseCategory = "rent" | "salaries" | "electricity" | "water" | "internet" | "other";

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  rent: "إيجار",
  salaries: "مرتبات",
  electricity: "كهرباء",
  water: "مياه",
  internet: "إنترنت",
  other: "أخرى",
};

export type ProductHistoryEventType =
  | "created"
  | "updated"
  | "restocked"
  | "decreased"
  | "sold"
  | "returned";

export interface ProductHistoryEvent {
  id: string;
  productId: string;
  productName: string;
  type: ProductHistoryEventType;
  delta?: number;
  quantityAfter?: number;
  note?: string;
  createdAt: Date;
}

export interface Expense {
  id: string;
  title: string;
  amount: number;
  category: ExpenseCategory;
  date: Date;
  note?: string;
}