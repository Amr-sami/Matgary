// Receipt-aware tools:
//   - get_receipt_settings — read the Owner's current receipt-identity config
//     from the authoritative shop_settings row.
//   - preview_update_receipt_settings — staged write, runs through the
//     existing F5 confirm pipeline (executor lives in lib/ai/write/execute.ts
//     as execUpdateReceiptSettings). Historical sales are never affected.
//   - prepare_receipt_whatsapp — returns a wa.me deep-link + the professional
//     filename so the user can MANUALLY share the receipt PDF. The Agent must
//     NEVER claim the message was sent — this just opens WhatsApp.
//
// No WhatsApp API integration is created. No PDF generation runs here (the
// user still taps the Share action from the existing POS/sales receipt flow).

import { eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { sales } from "@/lib/db/schema";
import { getPrimaryBranchId } from "@/lib/api/branch-context";
import { getShopSettings } from "@/lib/repo/settings";
import { normalizeEgyptPhoneAny } from "@/lib/validators/egypt";
import { receiptFilename } from "@matgary/domain/receipt/filename";

import { tr } from "../i18n";
import { createPending } from "../write/pending";
import type { Tool } from "./types";
import type { AiBlock, Locale } from "../responses";

/* ───────────────────────── get_receipt_settings ────────────────────────── */

export const getReceiptSettings: Tool = {
  name: "get_receipt_settings",
  description:
    "Read the store's current receipt-identity settings — slogan, address, tax registration / tax card, return policy, reference prefix, visibility toggles, logo URL. These are used by the real receipt renderer (web + mobile) and by generated PDFs. Historical sales are unaffected by changes.",
  requiredPermission: "view_settings",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async handler(ctx) {
    const branchId = await getPrimaryBranchId(ctx.tenantId);
    if (!branchId) {
      return { ok: false, error: "NO_PRIMARY_BRANCH" };
    }
    const s = await getShopSettings(ctx.tenantId, branchId);
    return {
      ok: true,
      data: {
        shopName: s.shopName,
        shopPhone: s.shopPhone,
        receiptLogoUrl: s.receiptLogoUrl,
        receiptLogoSize: s.receiptLogoSize,
        receiptLanguage: s.receiptLanguage,
        receiptAddress: s.receiptAddress,
        receiptSlogan: s.receiptSlogan,
        receiptTaxRegistration: s.receiptTaxRegistration,
        receiptTaxCardNumber: s.receiptTaxCardNumber,
        receiptReturnPolicy: s.receiptReturnPolicy,
        receiptReferencePrefix: s.receiptReferencePrefix,
        receiptShowAddress: s.receiptShowAddress,
        receiptShowSlogan: s.receiptShowSlogan,
        receiptShowTaxInfo: s.receiptShowTaxInfo,
        receiptShowReturnPolicy: s.receiptShowReturnPolicy,
      },
    };
  },
};

/* ─────────────── preview_update_receipt_settings (staged) ──────────────── */

export const previewUpdateReceiptSettings: Tool = {
  name: "preview_update_receipt_settings",
  description:
    "PREVIEW a change to the store's receipt-identity settings (slogan, address, tax registration/card, return policy, reference prefix, per-row show/hide). Writes nothing; returns a confirmation block the user taps to execute. Changes take effect on the NEXT printed/shared receipt; historical sales are not revalued.",
  requiredPermission: "view_settings",
  parameters: {
    type: "object",
    properties: {
      receiptSlogan: { type: "string", maxLength: 200 },
      receiptAddress: { type: "string", maxLength: 200 },
      receiptTaxRegistration: { type: "string", maxLength: 80 },
      receiptTaxCardNumber: { type: "string", maxLength: 80 },
      receiptReturnPolicy: { type: "string", maxLength: 500 },
      receiptReferencePrefix: { type: "string", maxLength: 8 },
      receiptShowAddress: { type: "boolean" },
      receiptShowSlogan: { type: "boolean" },
      receiptShowTaxInfo: { type: "boolean" },
      receiptShowReturnPolicy: { type: "boolean" },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    // Keep only the known keys — the executor applies them as-is.
    const KEYS = [
      "receiptSlogan",
      "receiptAddress",
      "receiptTaxRegistration",
      "receiptTaxCardNumber",
      "receiptReturnPolicy",
      "receiptReferencePrefix",
      "receiptShowAddress",
      "receiptShowSlogan",
      "receiptShowTaxInfo",
      "receiptShowReturnPolicy",
    ] as const;
    const params: Record<string, unknown> = {};
    for (const k of KEYS) if (k in args) params[k] = args[k];
    if (Object.keys(params).length === 0) {
      return { ok: false, error: "INVALID_PARAMS", reason: "At least one receipt field must be provided." };
    }

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "update_receipt_settings",
      params,
      preview: { locale: ctx.locale ?? "en", changed: Object.keys(params) },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.receiptSettings.title", locale),
      summary: tr("write.receiptSettings.summary", locale),
      actionLabel: tr("write.receiptSettings.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ───────────────────── prepare_receipt_whatsapp ────────────────────────── */

export const prepareReceiptWhatsapp: Tool = {
  name: "prepare_receipt_whatsapp",
  description:
    "Prepare a MANUAL WhatsApp share for a completed sale's receipt. Returns the professional filename, the customer phone (normalised), and a wa.me deep-link the user taps to OPEN WhatsApp. DOES NOT SEND the message. The Agent must tell the user the WhatsApp sheet will open with the customer prefilled and they still have to tap Send inside WhatsApp. No WhatsApp API is called.",
  requiredPermission: "record_sales",
  parameters: {
    type: "object",
    properties: {
      sale_id: { type: "string", description: "uuid of the sale in this tenant." },
    },
    required: ["sale_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const id = typeof args.sale_id === "string"
      ? args.sale_id
      : "";
    if (!id) return { ok: false, error: "INVALID_PARAMS", reason: "sale_id must be a uuid" };

    const [sale] = await withTenant(ctx.tenantId, async (tx) =>
      tx
        .select({
          id: sales.id,
          invoiceId: sales.invoiceId,
          saleDate: sales.saleDate,
          customerPhone: sales.customerPhone,
          tenantId: sales.tenantId,
        })
        .from(sales)
        .where(eq(sales.id, id))
        .limit(1),
    );
    if (!sale || sale.tenantId !== ctx.tenantId) {
      return { ok: false, error: "NOT_FOUND", reason: "Sale not found in your store." };
    }

    // Need the reference prefix for the professional filename — same source
    // the real receipt uses.
    const branchId = await getPrimaryBranchId(ctx.tenantId);
    const settings = branchId ? await getShopSettings(ctx.tenantId, branchId) : null;
    const prefix = settings?.receiptReferencePrefix ?? null;

    const filename = receiptFilename({
      invoiceId: sale.invoiceId ?? sale.id,
      saleDate: sale.saleDate,
      referencePrefix: prefix,
    });

    const normalisedPhone = normalizeEgyptPhoneAny(sale.customerPhone ?? "");
    const hasPhone = Boolean(normalisedPhone);
    const waUrl = hasPhone
      ? `https://wa.me/${normalisedPhone!.replace(/^\+/, "")}`
      : null;

    return {
      ok: true,
      data: {
        saleId: sale.id,
        invoiceId: sale.invoiceId,
        filename,
        customerPhonePresent: hasPhone,
        whatsappUrl: waUrl,
        note:
          "This prepares a MANUAL share. Opening wa.me starts a WhatsApp chat — the user must still attach the PDF (from the sale's Share action) and tap Send inside WhatsApp. No message is sent by the Agent.",
      },
    };
  },
};
