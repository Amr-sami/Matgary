import "dotenv/config";

import { ingestDocument } from "@/lib/ai/knowledge/ingest";

/**
 * F9 — Dev-only seed of a tiny company-knowledge corpus for the primary dev
 * tenant. Each doc is small on purpose — the live smoke only needs enough
 * signal to prove retrieval + grounding + language routing.
 *
 * Idempotent: ingestDocument hashes the content and short-circuits when the
 * same body is re-ingested. Supersede defaults to true so re-running with
 * edited text correctly bumps the version.
 */

const TENANT_ID = "f1290217-62c3-423e-9447-defb24c37734";

const docs: Array<{
  title: string;
  documentType: "policy" | "sop" | "faq" | "manual";
  language: "ar" | "en" | "pt" | "fr" | "es";
  body: string;
}> = [
  {
    title: "Return Policy",
    documentType: "policy",
    language: "en",
    body: `# Return Policy

## Overview
Customers may return eligible products within 30 days of purchase.

## Damaged Products
Damaged products can be returned within 30 days if the damage is reported
on arrival. Photographic evidence is required. The shop replaces the item
or refunds the full purchase amount to the original payment method within
7 business days.

## Non-returnable Items
Perfume testers, opened digital products, and clearance items are
non-returnable unless defective on arrival.

## Store Credit
Store credit is issued instead of cash refund when the original payment
was via store credit or loyalty points.
`,
  },
  {
    title: "Attendance SOP",
    documentType: "sop",
    language: "en",
    body: `# Attendance SOP

## Punctuality
Employees must clock in no later than 10 minutes after their scheduled
start time. Repeated lateness is logged in the monthly review.

## Breaks
A single 30-minute lunch break and two 10-minute short breaks are allowed
per 8-hour shift.

## Leave
Leave requests must be submitted at least 72 hours in advance except for
medical emergencies, which require a doctor's note on return.
`,
  },
  {
    title: "سياسة الإرجاع",
    documentType: "policy",
    language: "ar",
    body: `# سياسة الإرجاع

## نظرة عامة
يحق للعميل إرجاع المنتجات المؤهلة خلال ٣٠ يومًا من تاريخ الشراء.

## المنتجات التالفة
يمكن إرجاع المنتجات التالفة خلال ٣٠ يومًا بشرط الإبلاغ عن الضرر عند الاستلام
مع تقديم صور فوتوغرافية كإثبات. يقوم المتجر باستبدال المنتج أو رد كامل المبلغ
إلى وسيلة الدفع الأصلية خلال ٧ أيام عمل.

## المنتجات غير القابلة للإرجاع
العينات التجريبية للعطور والمنتجات الرقمية المفتوحة ومنتجات التصفية
غير قابلة للإرجاع ما لم تكن معيبة عند الوصول.
`,
  },
  {
    title: "FAQ — Customer Loyalty",
    documentType: "faq",
    language: "en",
    body: `# Customer Loyalty FAQ

## How do points work?
Customers earn 1 point per 10 EGP spent. 100 points can be redeemed for a
10 EGP discount on a future purchase.

## Do points expire?
Yes. Points expire after 12 months of account inactivity.

## Can points be transferred?
Points are tied to the customer's phone number and are non-transferable.
`,
  },
];

async function main() {
  console.log(`Seeding ${docs.length} knowledge document(s) for tenant ${TENANT_ID}…`);
  for (const d of docs) {
    try {
      const r = await ingestDocument({
        tenantId: TENANT_ID,
        title: d.title,
        documentType: d.documentType,
        body: d.body,
        language: d.language,
        source: "seed",
        fileName: `${d.title}.md`,
        mimeType: "text/markdown",
      });
      console.log(`  ✓ ${d.title} → ${r.status} (v${r.version}, ${r.chunksCreated} chunks)`);
    } catch (err) {
      console.log(`  ✗ ${d.title} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
