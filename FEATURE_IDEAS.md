# Feature Ideas — Matgary

Suggestions grouped by impact. Each item lists the problem it solves and an implementation hint that reuses existing tables/components where possible.

---

## Tier 1 — High-impact, fills real gaps

### 1. Barcode scanning (POS + inventory)
- **Why:** Cashier currently searches by name. Scanning a barcode at checkout / receiving is the single biggest speed win in any retail app.
- **How:** Add a `barcode` column to `products`. Use the device camera via `BarcodeDetector` API (no library needed in modern Chrome/Safari) for the POS form and `add-product` wizard. Fallback to a USB scanner (it just types into the focused input).
- **Touches:** `app/sales/`, `components/sales/`, `app/inventory/`.

### 2. Suppliers + Purchase Orders
- **Why:** You can sell stock but can't track *where it came from*. No reorder workflow, no supplier debts, no cost-history when prices change.
- **How:** New tables `suppliers`, `purchase_orders`, `purchase_order_items`. When a PO is marked "received," it bumps `products.quantity` and writes to `product_history`. Supplier debts can mirror the customer-debt pattern.
- **Touches:** new `/suppliers` and `/purchases` routes; integrates with `expenses` for payments to suppliers.

### 3. Customer purchase history + loyalty
- **Why:** `customers` is currently just lookup-by-phone. Owners can't see a customer's lifetime value, last visit, or reward repeat buyers.
- **How:** Store customer rows properly (id, name, phone, total spend cached). Show timeline on `/customers/[id]`. Add a simple points rule (e.g. 1 pt per 10 EGP) and a redeem flow at POS.
- **Touches:** `customers` table (new), `sales.customerPhone` already exists — just join.

### 4. Stocktake / inventory count workflow
- **Why:** Periodic counts don't fit in "manual adjust." A real stocktake locks SKUs, lets staff scan/count, then commits diffs in one batch with a reason.
- **How:** New `stocktake_sessions` + `stocktake_items` tables. Reuse `product_history` for the audit trail.
- **Touches:** new `/stocktake` route; consumes barcode scanner from #1.

### 5. Cashier shift / till reconciliation (closing the day)
- **Why:** End-of-day cash count vs. system-recorded cash sales catches theft and miscounts.
- **How:** New `register_sessions` table (open/close, opening float, closing count, expected vs. actual). Tie sales to a session_id. End-of-shift screen shows the variance.
- **Touches:** new `/register` route; `sales` gets a nullable `session_id`.

---

## Tier 2 — Sharpens what's already there

### 6. Promotions / discounts engine
- **Why:** There's no way to run "buy 2 get 1," percentage off, or category-wide sales.
- **How:** `promotions` table (type, scope, value, start/end). POS evaluates active promos at line-item time. Keep it deliberately simple — start with: % off product, % off category, fixed amount off cart over N.

### 7. Reorder suggestions
- **Why:** `LowStockAlert` flags items already low. The next step: predict *what to reorder and how much* based on sales velocity over the last 30/60 days.
- **How:** Compute weekly velocity per product from `sales` rows; surface a "Reorder list" tab on `/inventory`. No ML — just `qty_sold_30d / 30 * lead_time_days`.

### 8. Tax / VAT handling
- **Why:** Egyptian retailers running formal invoices need VAT lines. Currently price is single-figure.
- **How:** Add `tax_rate` to `shop_settings` and optional per-product override. Receipt PDF shows subtotal / VAT / total separately. Toggle in settings to turn it on.

### 9. Multi-payment method tracking
- **Why:** Currently sales are paid/unpaid binary. Real shops take cash, Instapay, Vodafone Cash, card.
- **How:** Add `payment_method` enum on `sales`. Optional split-payment table. Powers a "payments by method" insight chart for free.

### 10. Unified activity log
- **Why:** `product_history` exists but there's no UI surfacing *what happened in my store today* across products, sales, returns, staff actions.
- **How:** New thin `activity_log` table OR a view that UNIONs the existing event tables. Render as a feed on `/insights` or a dedicated `/activity` page.

### 11. Customer-facing receipt page (public link)
- **Why:** The WhatsApp template already substitutes `{receiptLink}` — but unclear if a public read-only invoice page exists. If not, this is a 1-day win that makes WhatsApp receipts actually useful.
- **How:** `/r/[publicId]` route, server-rendered, no auth, signed short-id on each sale.

---

## Tier 3 — Team & operations polish

### 12. Leave requests / shift swaps
- **Why:** Attendance is solid for clock-in, but there's no way for staff to *request* time off or swap shifts.
- **How:** `leave_requests` table with status (pending/approved/rejected). Owner approval inbox on `/team`.

### 13. Staff performance dashboard
- **Why:** Owner can see sales totals but not "who sold what." Sales rows likely already have a `userId` — just chart it.
- **How:** New tab on `/insights`: sales-per-employee, returns-per-employee, hours-vs-revenue.

### 14. Recurring expenses
- **Why:** Rent, internet, and subscriptions repeat monthly. Re-typing them is busywork and they get forgotten.
- **How:** Add `is_recurring` + `recurrence_rule` to `expenses`. Cron job or on-load check creates the next instance when due.

### 15. Notification center (in-app + WhatsApp)
- **Why:** Owners only see low-stock when they open the dashboard. Push it to them.
- **How:** Daily digest at 9am via Green API: low stock count, yesterday's revenue, unpaid invoices > 7d. Reuses existing WhatsApp wiring.

---

## Tier 4 — Growth / nice-to-haves

### 16. Global command palette (Cmd+K)
Quick-jump to any product / customer / page. Cheap to build, big perceived-quality bump.

### 17. PWA / installable mobile experience
You already have a mobile bottom nav — adding a manifest + service worker makes it installable. Owners running the app on a phone behind the counter is a real use case.

### 18. CSV/Excel export everywhere
Sales, expenses, returns, customers — owners want the data in their accountant's format. You already have payroll export; generalize the helper.

### 19. Dark mode
Late-night work in dim corner stores is the actual use case. Tailwind v4 already supports it — just need a toggle and a color token pass.

### 20. Backup / restore (per-tenant export)
A single-button "download my whole store" (JSON or SQL dump scoped by tenantId). Critical for trust before owners commit data to your platform.

---

## Suggested order

If shipping one at a time:
1. **#1 Barcode scanning** — biggest daily friction reduction.
2. **#3 Customer history** — turns the customers page from a stub into a feature.
3. **#5 Cashier shift / till reconciliation** — the feature that prevents money from disappearing.
4. **#2 Suppliers + POs** — unlocks proper cost tracking and supplier debts.
5. **#7 Reorder suggestions** — naturally follows once velocity data is being read.

Then revisit Tier 2.
