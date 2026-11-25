/**
 * Customer account statement — "كشف حساب العميل".
 *
 * Render → PDF → share. Mirrors the pattern in src/receipt/share.ts (expo-print
 * + expo-sharing), but for the customer ledger instead of a single sale.
 * One tap on the customer detail page's "كشف حساب" button fires
 * `shareCustomerStatement()`; the native share sheet opens with a PDF ready
 * to send to WhatsApp / Files / Mail (no WhatsApp integration — the OS picker
 * is enough, matching how receipts are already shared).
 *
 * Data is passed in from the caller rather than refetched here, so the sheet
 * uses the EXACT numbers the owner is already looking at on screen.
 */

import { File, Paths } from "expo-file-system";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

import { t } from "@/i18n";
import type { catalog } from "@matgary/api-client";

type Ledger = catalog.CustomerLedger;
type Payment = catalog.CustomerPaymentEvent;

export interface StatementInput {
  shopName: string | null;
  shopPhone: string | null;
  branchName: string | null;
  customer: {
    name: string | null;
    phone: string;
  };
  ledger: Ledger;
  payments: Payment[];
}

export class StatementShareUnavailableError extends Error {
  constructor() {
    super("sharing unavailable");
    this.name = "StatementShareUnavailableError";
  }
}

export async function shareCustomerStatement(input: StatementInput): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new StatementShareUnavailableError();
  const html = buildStatementHtml(input);
  const { uri } = await Print.printToFileAsync({
    html,
    // A4-ish portrait, in points (72dpi); expo-print sizes a PDF page by these.
    width: 595,
    height: 842,
    margins: { left: 36, top: 36, right: 36, bottom: 36 },
  });
  // expo-print writes to a tmp path with a random name; WhatsApp / Mail /
  // Files use that name as the attachment title verbatim, so rename the file
  // first — "كشف حساب أحمد الحناوي بتاريخ 2026-11-02.pdf" lands in the chat.
  const displayName = input.customer.name?.trim() || input.customer.phone;
  const fileName = buildStatementFileName(displayName, new Date());
  const src = new File(uri);
  const dest = new File(Paths.cache, fileName);
  try {
    await src.move(dest, { overwrite: true });
  } catch {
    // A rename failure is cosmetic — the PDF still exists at the source URI.
    // Fall through and share the original so the user does not lose the doc.
    await Sharing.shareAsync(uri, {
      mimeType: "application/pdf",
      UTI: "com.adobe.pdf",
      dialogTitle: t("mobile.customers.statementShareTitle", { name: displayName }),
    });
    return;
  }
  await Sharing.shareAsync(dest.uri, {
    mimeType: "application/pdf",
    UTI: "com.adobe.pdf",
    dialogTitle: t("mobile.customers.statementShareTitle", { name: displayName }),
  });
}

/**
 * "كشف حساب {name} بتاريخ {YYYY-MM-DD}.pdf" with path-unsafe characters
 * stripped. Arabic letters are preserved — iOS and modern Android both render
 * Arabic filenames fine in the share sheet.
 */
function buildStatementFileName(name: string, date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  // Forbid separators and shell/url-sensitive chars; collapse the rest.
  const safeName = name
    .replace(/[\\/:*?"<>|\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "customer";
  return `كشف حساب ${safeName} بتاريخ ${y}-${m}-${d}.pdf`;
}

// ---------------------------------------------------------------------------
// HTML template — Arabic-aware, RTL, Cairo-fallback-safe.

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMoney(n: number): string {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ج.م`;
}

function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  // Western digits, Arabic-friendly short date.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const paymentLabel = (m: string | null | undefined) => {
  switch (m) {
    case "cash":
      return "نقدي";
    case "instapay":
      return "إنستاباي";
    case "wallet":
      return "محفظة";
    case "card":
      return "فيزا";
    case "deferred":
      return "آجل";
    default:
      return "—";
  }
};

function buildStatementHtml(input: StatementInput): string {
  const { shopName, shopPhone, branchName, customer, ledger, payments } = input;
  const generatedAt = fmtDate(new Date());

  const outstanding = ledger.outstandingBalance ?? 0;
  const totalPurchases = ledger.lifetimeValue ?? 0;
  const totalPaid = ledger.paidBalance ?? 0;

  const invoicesRows = ledger.invoices
    .map((inv) => {
      const balance = inv.balance ?? inv.total - inv.amountPaid;
      const statusClass = inv.isPaid ? "ok" : balance > 0 ? "due" : "muted";
      const statusLabel = inv.isPaid ? "مدفوع" : balance > 0 ? "آجل" : "—";
      return `
        <tr>
          <td class="num">${esc(fmtDate(inv.date))}</td>
          <td>${esc(inv.invoiceId)}</td>
          <td class="num mono">${esc(fmtMoney(inv.total))}</td>
          <td class="num mono">${esc(fmtMoney(inv.amountPaid))}</td>
          <td class="num mono">${esc(fmtMoney(balance))}</td>
          <td><span class="pill ${statusClass}">${statusLabel}</span></td>
        </tr>
      `;
    })
    .join("");

  // Voided payments are excluded from paidBalance server-side; omit them here
  // too so the table reconciles with the KPIs above.
  const visiblePayments = payments.filter((p) => !p.voidedAt);
  const paymentsRows = visiblePayments.length
    ? visiblePayments
        .map(
          (p) => `
          <tr>
            <td class="num">${esc(fmtDate(p.recordedAt))}</td>
            <td>${esc(paymentLabel(p.method))}</td>
            <td class="num mono">${esc(fmtMoney(p.amount))}</td>
            <td>${esc(p.invoiceId ?? "—")}</td>
          </tr>
        `,
        )
        .join("")
    : `<tr><td colspan="4" class="empty">لا توجد مدفوعات مسجّلة</td></tr>`;

  // Inline Cairo-first CSS. We lean on standard Arabic fallbacks ("Noto
  // Naskh Arabic", "Geeza Pro") so the PDF renders even if the system has no
  // Cairo installed; expo-print uses WebKit under the hood on both platforms.
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>كشف حساب — ${esc(customer.name ?? customer.phone)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Cairo, "Noto Naskh Arabic", "Geeza Pro", Tahoma, Arial, sans-serif;
    color: #1A1A1A;
    font-size: 11pt;
    line-height: 1.4;
    direction: rtl;
    padding: 24px;
  }
  .brand {
    text-align: center;
    padding-bottom: 12px;
    border-bottom: 2px solid #1203E3;
    margin-bottom: 20px;
  }
  .brand-name { font-size: 20pt; font-weight: 700; color: #1203E3; margin: 0; }
  .brand-meta { font-size: 10pt; color: #6B6B6B; margin-top: 4px; }
  h1 { font-size: 15pt; margin: 0 0 4px; }
  .doc-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 18px;
  }
  .doc-head .right, .doc-head .left { max-width: 48%; }
  .label { font-size: 9pt; color: #6B6B6B; margin-bottom: 2px; }
  .value { font-size: 11pt; font-weight: 600; }
  .kpis {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 10px;
    margin-bottom: 18px;
  }
  .kpi {
    border: 1px solid #E8E4DC;
    border-radius: 8px;
    padding: 10px 12px;
  }
  .kpi .label { font-size: 9pt; margin-bottom: 4px; }
  .kpi .value { font-size: 14pt; }
  .kpi.warn { background: #FFF7ED; border-color: #FFEDD4; }
  .kpi.warn .value { color: #CA3500; }
  .kpi.ok .value { color: #1E8449; }
  h2 {
    font-size: 12pt;
    margin: 14px 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #E8E4DC;
  }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    background: #F3F4F6;
    text-align: right;
    padding: 6px 8px;
    font-size: 9.5pt;
    font-weight: 600;
    color: #374151;
    border-bottom: 1px solid #E8E4DC;
  }
  tbody td {
    padding: 6px 8px;
    font-size: 10pt;
    border-bottom: 1px solid #F3F4F6;
    vertical-align: top;
  }
  td.num { white-space: nowrap; }
  td.mono { font-variant-numeric: tabular-nums; direction: ltr; text-align: left; }
  td.empty { text-align: center; color: #6B6B6B; padding: 14px; }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 9pt;
    font-weight: 600;
    white-space: nowrap;
  }
  .pill.ok { background: #EAFAF1; color: #1E8449; }
  .pill.due { background: #FFEDD4; color: #CA3500; }
  .pill.muted { background: #F3F4F6; color: #6B6B6B; }
  footer {
    margin-top: 24px;
    padding-top: 12px;
    border-top: 1px solid #E8E4DC;
    font-size: 9pt;
    color: #6B6B6B;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="brand">
    <div class="brand-name">${esc(shopName ?? "متجري")}</div>
    <div class="brand-meta">
      ${esc(branchName ?? "")}
      ${shopPhone ? ` · ${esc(shopPhone)}` : ""}
    </div>
  </div>

  <div class="doc-head">
    <div class="right">
      <h1>كشف حساب العميل</h1>
      <div class="label">تاريخ الإصدار</div>
      <div class="value">${esc(generatedAt)}</div>
    </div>
    <div class="left">
      <div class="label">العميل</div>
      <div class="value">${esc(customer.name ?? customer.phone)}</div>
      <div class="label" style="margin-top:6px">الهاتف</div>
      <div class="value mono" style="direction:ltr; text-align:right">${esc(customer.phone)}</div>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi">
      <div class="label">إجمالي المشتريات</div>
      <div class="value mono">${esc(fmtMoney(totalPurchases))}</div>
    </div>
    <div class="kpi ok">
      <div class="label">المدفوع</div>
      <div class="value mono">${esc(fmtMoney(totalPaid))}</div>
    </div>
    <div class="kpi ${outstanding > 0 ? "warn" : ""}">
      <div class="label">المستحق</div>
      <div class="value mono">${esc(fmtMoney(outstanding))}</div>
    </div>
  </div>

  <h2>الفواتير (${ledger.invoices.length})</h2>
  <table>
    <thead>
      <tr>
        <th>التاريخ</th>
        <th>رقم الفاتورة</th>
        <th>الإجمالي</th>
        <th>المدفوع</th>
        <th>المتبقي</th>
        <th>الحالة</th>
      </tr>
    </thead>
    <tbody>
      ${invoicesRows || `<tr><td colspan="6" class="empty">لا توجد فواتير</td></tr>`}
    </tbody>
  </table>

  <h2>المدفوعات (${visiblePayments.length})</h2>
  <table>
    <thead>
      <tr>
        <th>التاريخ</th>
        <th>الطريقة</th>
        <th>المبلغ</th>
        <th>الفاتورة</th>
      </tr>
    </thead>
    <tbody>
      ${paymentsRows}
    </tbody>
  </table>

  <footer>
    هذا الكشف تم إنشاؤه بتاريخ ${esc(generatedAt)} من تطبيق ستور
  </footer>
</body>
</html>`;
}
