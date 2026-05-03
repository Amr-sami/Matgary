// Default WhatsApp message template — copied verbatim from the existing
// lib/settings.ts so a fresh tenant has the same messaging UX as Corner Store.
export const DEFAULT_MESSAGE_TEMPLATE = `مرحباً {{customer_name}} 👋

شكراً لتسوقك من {{shop_name}}.
رقم الفاتورة: {{invoice_id}}
الإجمالي: {{total}}

لمراجعة الفاتورة الإلكترونية:
{{receipt_link}}`;
