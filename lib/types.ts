export type Category = "watches" | "perfumes" | "sunglasses";
export type Gender = "male" | "female";

export const CATEGORY_LABELS: Record<Category, string> = {
  watches: "ساعات",
  perfumes: "برفانات",
  sunglasses: "نظارات",
};

export const GENDER_LABELS: Record<Gender, string> = {
  male: "رجالي",
  female: "حريمي",
};

export const WATCH_BRANDS = ["Other"];

export interface Product {
  id: string;
  name: string;
  category: Category;
  gender: Gender;
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