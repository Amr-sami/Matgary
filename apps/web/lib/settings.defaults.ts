// Default WhatsApp message template. Placeholder syntax must match the
// substitute() function in lib/settings.ts — `{camelCase}`, single braces.
// Receipts are sent as PDF attachments, so the template never references a
// public link — the PDF itself is the receipt.
export const DEFAULT_MESSAGE_TEMPLATE = `مرحباً {customerName} 👋

شكراً لتسوقك من {shopName}.
رقم الفاتورة: {invoiceId}
الإجمالي: {totalPrice}`;
