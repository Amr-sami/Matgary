// Digital collections — the Egyptian Tax Authority (ETA) payment-method code
// (spec 06 §4.8, 03 §B.1 "ETA mapping").
//
// Source [market-legal.md §3.5]: https://sdk.invoicing.eta.gov.eg/codes/payment-methods/
// and https://sdk.invoicing.eta.gov.eg/documents/receipt-v1-2/.
// No caller exists at M1. The function exists so that a future e-receipt
// integration inherits ONE mapping; the collection's payer reference is kept
// for the receipt's `buyer.paymentNumber`.
//
// Hermes-safe.

import type { PaymentMethod, SalePaymentMethod } from "./types";

/** The ETA payment-method code list [ETA-PM]. */
export type EtaPaymentMethodCode = "C" | "V" | "CC" | "VC" | "VO" | "PR" | "GC" | "P" | "O";

/**
 * cash → C · card → V · instapay → O · wallet → O · deferred → O (D06-d: the
 * list has no credit code; UNVERIFIED — ask a tax accountant which code an
 * on-account B2C receipt uses) · initial → throws (a ledger opening row, not a
 * payment method).
 */
export function etaPaymentMethodCode(method: PaymentMethod | SalePaymentMethod): EtaPaymentMethodCode {
  switch (method) {
    case "cash":
      return "C";
    case "card":
      return "V";
    case "instapay":
    case "wallet":
      return "O";
    case "deferred":
      return "O";
    case "initial":
      throw new RangeError('etaPaymentMethodCode: "initial" is not a payment method');
    default: {
      const never: never = method;
      throw new RangeError(`etaPaymentMethodCode: unknown method ${String(never)}`);
    }
  }
}

/**
 * Max length of `buyer.paymentNumber` (String). UNVERIFIED: 50 mirrors the
 * receipt's `paymentMethod` String(50).
 */
export const ETA_PAYMENT_NUMBER_MAX = 50;
