// Default WhatsApp message template. Placeholder syntax must match the
// substitute() function in lib/settings.ts — `{camelCase}`, single braces.
// Previous version used `{{snake_case}}` which never matched, so the live
// preview at /settings rendered the raw template unchanged.
export const DEFAULT_MESSAGE_TEMPLATE = `مرحباً {customerName} 👋

شكراً لتسوقك من {shopName}.
رقم الفاتورة: {invoiceId}
الإجمالي: {totalPrice}

لمراجعة الفاتورة الإلكترونية:
{receiptLink}`;
