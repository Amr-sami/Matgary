"use client";

// Customer + payment + loyalty state. All three live together because
// they're entered in the same UI section and have intertwined
// behavior: typing a customer phone fetches that customer's wallet,
// and the wallet drives the loyalty redemption inputs that the
// cashier may apply against the cart.
//
// Side effects owned here:
//   - Debounced /api/customers/by-phone/.../wallet fetch (400ms)
//     when the cashier types or pastes a phone AND the active
//     branch has loyaltyEnabled.
//   - Reset of the redeem-points / apply-credit inputs whenever the
//     customer phone changes (otherwise a previous customer's
//     redemption would silently apply to the next sale).
//
// NOT in this hook:
//   - The cart-after-discount math that the loyalty clamp needs;
//     that lives in lib/sales/cart-math.ts and is computed by the
//     orchestrator from cart + order-discount + wallet state.

import { useEffect, useState } from "react";
import type { PaymentMethod } from "@/lib/types";

export interface UseCustomerPaymentOptions {
  /** Whether the active branch's loyalty programme is enabled. When
   *  false, we skip the wallet fetch entirely. */
  loyaltyEnabled: boolean;
}

export interface UseCustomerPaymentResult {
  // Customer
  customerName: string;
  setCustomerName: (s: string) => void;
  customerPhone: string;
  setCustomerPhone: (s: string) => void;

  // Payment
  paymentMethod: PaymentMethod;
  setPaymentMethod: (m: PaymentMethod) => void;
  /** For deferred sales only: amount the customer paid at the counter.
   *  Stored as a string so the input can be edited fluently. Parse
   *  to a number at submit. */
  amountPaidNowInput: string;
  setAmountPaidNowInput: (s: string) => void;

  // Loyalty
  walletPoints: number;
  walletCredit: number;
  redeemPointsInput: string;
  setRedeemPointsInput: (s: string) => void;
  applyCreditInput: string;
  setApplyCreditInput: (s: string) => void;
}

export function useCustomerPayment({
  loyaltyEnabled,
}: UseCustomerPaymentOptions): UseCustomerPaymentResult {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [amountPaidNowInput, setAmountPaidNowInput] = useState("");

  const [walletPoints, setWalletPoints] = useState(0);
  const [walletCredit, setWalletCredit] = useState(0);
  const [redeemPointsInput, setRedeemPointsInput] = useState("");
  const [applyCreditInput, setApplyCreditInput] = useState("");

  // Debounced wallet fetch — same 400ms as before.
  useEffect(() => {
    if (!loyaltyEnabled || !customerPhone.trim()) {
      setWalletPoints(0);
      setWalletCredit(0);
      return;
    }
    const phone = customerPhone.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/customers/by-phone/${encodeURIComponent(phone)}/wallet`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (!res.ok) {
          setWalletPoints(0);
          setWalletCredit(0);
          return;
        }
        const json = (await res.json()) as {
          wallet: { points: number; credit: number };
        };
        setWalletPoints(json.wallet.points);
        setWalletCredit(json.wallet.credit);
      } catch {
        if (!cancelled) {
          setWalletPoints(0);
          setWalletCredit(0);
        }
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [customerPhone, loyaltyEnabled]);

  // Reset redemption inputs when the customer changes — otherwise a
  // previous customer's "redeem 50 pts" would silently apply to the
  // next sale.
  useEffect(() => {
    setRedeemPointsInput("");
    setApplyCreditInput("");
  }, [customerPhone]);

  return {
    customerName,
    setCustomerName,
    customerPhone,
    setCustomerPhone,
    paymentMethod,
    setPaymentMethod,
    amountPaidNowInput,
    setAmountPaidNowInput,
    walletPoints,
    walletCredit,
    redeemPointsInput,
    setRedeemPointsInput,
    applyCreditInput,
    setApplyCreditInput,
  };
}
