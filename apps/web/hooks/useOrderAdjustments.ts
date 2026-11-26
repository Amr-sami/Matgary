"use client";

// Order-level adjustments: note, order-wide discount, custom sale date.
// Tiny standalone state machine — pulled out for symmetry with the
// other useCart/useCustomerPayment hooks and to remove ~10 LOC of
// state declarations from SaleForm.

import { useState } from "react";
import type { DiscountType } from "@/lib/types";

export interface UseOrderAdjustmentsResult {
  note: string;
  setNote: (s: string) => void;
  orderDiscountType: DiscountType;
  setOrderDiscountType: (t: DiscountType) => void;
  orderDiscountValue: number;
  setOrderDiscountValue: (n: number) => void;
  useCustomDate: boolean;
  setUseCustomDate: (b: boolean) => void;
  customDate: string;
  setCustomDate: (s: string) => void;
  /** Today's date in YYYY-MM-DD — the initial value of customDate.
   *  Exposed because the date picker UI uses it as the `max` cap. */
  todayStr: string;
}

export function useOrderAdjustments(): UseOrderAdjustmentsResult {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [note, setNote] = useState("");
  const [orderDiscountType, setOrderDiscountType] = useState<DiscountType>("percentage");
  const [orderDiscountValue, setOrderDiscountValue] = useState(0);
  const [useCustomDate, setUseCustomDate] = useState(false);
  const [customDate, setCustomDate] = useState(todayStr);

  return {
    note,
    setNote,
    orderDiscountType,
    setOrderDiscountType,
    orderDiscountValue,
    setOrderDiscountValue,
    useCustomDate,
    setUseCustomDate,
    customDate,
    setCustomDate,
    todayStr,
  };
}
