// Slice 1 — shared types for the Financial Management module.
//
// Every monetary field is a `number` in EGP (same convention the rest of
// Storo uses). The engine guarantees no NaN / Infinity / undefined surface
// in a response — missing or zero inputs always resolve to the literal 0.

/** Half-open period `[from, to)` interpreted in the tenant's reporting
 *  timezone (see lib/finance/dates.ts). Both bounds are instants, not
 *  calendar days — the calendar → instant conversion is the caller's job. */
export interface FinancePeriod {
  from: Date;
  to: Date;
}

/** Raw source rows feeding the engine. Kept as a plain data shape so the
 *  calculator is a pure function and can be unit-tested without a DB. */
export interface PnLSource {
  /** Sale rows whose `saleDate` falls in the period. */
  sales: {
    saleId: string;
    quantitySold: number;
    returnedQuantity: number;
    pricePerUnit: number;
    /** Line subtotal before any discount — matches `sales.subtotal`. */
    subtotal: number;
    /** Line + order-level allocated discount — matches `sales.discountAmount`. */
    discountAmount: number;
    /** Snapshot cost at sale time. NEVER fall back to current product cost. */
    costPriceAtSale: number;
    /** Line post-discount total — matches `sales.totalPrice`. */
    totalPrice: number;
  }[];
  /** Return rows whose `returnDate` falls in the period, joined to the parent
   *  sale so the engine can price the return. A return in the period reverses
   *  revenue + COGS in the period, regardless of when the sale was rung. */
  returns: {
    returnId: string;
    saleId: string;
    returnedQuantityInPeriod: number;
    /** Parent sale snapshot — frozen with the return so a cost change later
     *  cannot revalue a historical return. */
    saleQuantitySold: number;
    salePricePerUnit: number;
    saleTotalPrice: number;
    saleCostPriceAtSale: number;
  }[];
  /** Expense rows (status='posted') whose `date` falls in the period.
   *  Grouped by category/group when assembled for the P&L statement. */
  expenses: {
    expenseId: string;
    amount: number;
    categoryId: string | null;
    categorySlug: string | null;
    categoryGroupSlug: string | null;
    categoryKind: "opex" | "other_income" | "other_expense" | null;
    isPayroll: boolean;
  }[];
  /** Finalized payroll periods whose `periodEnd` falls in the period. Amount
   *  = grossAmount + adjustmentsAmount. Drafts are explicitly excluded. */
  payrollExpenses: {
    payrollPeriodId: string;
    amount: number;
  }[];
  /** Money movements in the period — rendered separately, NEVER mixed into
   *  revenue / expense / profit. Shipped in the response so the UI can echo
   *  "money in / money out" without a second round-trip. */
  moneyMovements: {
    movementId: string;
    kind: string;
    amount: number;
    direction: "in" | "out";
  }[];
}

export interface CategoryBreakdownRow {
  categoryId: string | null;
  slug: string | null;
  nameEn: string | null;
  nameAr: string | null;
  groupSlug: string | null;
  groupNameEn: string | null;
  groupNameAr: string | null;
  amount: number;
  /** Share of total OpEx in the period, 0..1. 0 if total is 0. */
  share: number;
}

export interface PnL {
  /** Gross sales = Σ sales.subtotal (pre-discount). */
  grossSales: number;
  /** Σ discountAmount across sales in period. Order-level discount is
   *  already allocated across lines by the cart writer, so a single SUM
   *  produces the correct total — no double-count. */
  discounts: number;
  /** Returns-reversed revenue in period. A return in the period subtracts
   *  the kept-vs-returned share of the parent sale's totalPrice (post-
   *  discount), regardless of when the sale was rung. */
  returnsRevenue: number;
  /** = grossSales − discounts − returnsRevenue. */
  netSales: number;
  /** Σ (costPriceAtSale × quantitySold) for sales in period, MINUS the
   *  returns reversal (same cost snapshot × returnedQty for returns in
   *  period). No fallback to current product cost. */
  cogs: number;
  grossProfit: number;
  /** Total OpEx = posted expenses + finalized payroll periods. */
  operatingExpenses: number;
  /** OpEx broken down by group → subcategory. The engine groups by group
   *  slug so the UI can render the hierarchy without a second query. */
  operatingExpensesByGroup: {
    groupSlug: string;
    groupNameEn: string;
    groupNameAr: string;
    total: number;
    categories: CategoryBreakdownRow[];
  }[];
  /** Flat OpEx list, ordered desc by amount — handy for a single table. */
  operatingExpensesByCategory: CategoryBreakdownRow[];
  operatingProfit: number;
  otherIncome: number;
  otherExpense: number;
  netProfit: number;
  /** = netProfit / netSales. 0 when netSales = 0 (no divide-by-zero NaN). */
  netMargin: number;
  /** = grossProfit / netSales. 0 when netSales = 0. */
  grossMargin: number;
}

/** Overview response — a flatter KPI view for the dashboard-style tile. */
export interface FinancialOverview {
  period: { from: string; to: string };
  grossSales: number;
  discounts: number;
  returnsRevenue: number;
  netSales: number;
  cogs: number;
  grossProfit: number;
  grossMargin: number;
  operatingExpenses: number;
  operatingProfit: number;
  otherIncome: number;
  otherExpense: number;
  netProfit: number;
  netMargin: number;
  salesCount: number;
  returnsCount: number;
  moneyIn: number;
  moneyOut: number;
}
