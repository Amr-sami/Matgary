"use client";

import { useState, useEffect, useRef } from "react";
import { ProductSearchSelect } from "./ProductSearchSelect";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { recordSale } from "@/lib/firestore";
import type { Product, DiscountType } from "@/lib/types";
import { formatPrice } from "@/lib/utils";
import { Printer, Percent, DollarSign } from "lucide-react";
import { Receipt } from "./Receipt";

interface SaleFormProps {
  onSuccess: () => void;
  preselectedProduct?: Product | null;
}

interface LastSaleData {
  productName: string;
  brand?: string;
  quantity: number;
  pricePerUnit: number;
  subtotal: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountAmount: number;
  totalPrice: number;
  saleDate: Date;
}

export function SaleForm({ onSuccess, preselectedProduct }: SaleFormProps) {
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(preselectedProduct || null);
  const [quantity, setQuantity] = useState(1);
  const [pricePerUnit, setPricePerUnit] = useState(0);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  // Discount state
  const [discountType, setDiscountType] = useState<DiscountType>("percentage");
  const [discountValue, setDiscountValue] = useState(0);

  // Last sale for receipt
  const [lastSale, setLastSale] = useState<LastSaleData | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedProduct) {
      setPricePerUnit(selectedProduct.price);
    }
  }, [selectedProduct]);

  const subtotal = quantity * pricePerUnit;
  const discountAmount = discountValue > 0
    ? discountType === "percentage"
      ? Math.round((subtotal * discountValue) / 100)
      : Math.min(discountValue, subtotal)
    : 0;
  const totalPrice = subtotal - discountAmount;

  const handleSubmit = async () => {
    if (!selectedProduct || quantity < 1 || pricePerUnit < 1) return;
    setLoading(true);
    try {
      await recordSale(
        selectedProduct.id,
        quantity,
        pricePerUnit,
        note || undefined,
        discountValue > 0 ? discountType : undefined,
        discountValue > 0 ? discountValue : undefined
      );

      // Save last sale data for receipt
      setLastSale({
        productName: selectedProduct.name,
        brand: selectedProduct.brand,
        quantity,
        pricePerUnit,
        subtotal,
        discountType: discountValue > 0 ? discountType : undefined,
        discountValue: discountValue > 0 ? discountValue : undefined,
        discountAmount,
        totalPrice,
        saleDate: new Date(),
      });

      setSelectedProduct(null);
      setQuantity(1);
      setPricePerUnit(0);
      setNote("");
      setDiscountValue(0);
      onSuccess();
    } catch (error: any) {
      alert(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const isValid = selectedProduct && quantity >= 1 && pricePerUnit > 0 && quantity <= selectedProduct.quantity;

  return (
    <>
      <div className="bg-white rounded-xl p-5 shadow-sm border border-border">
        <h3 className="font-semibold mb-4">تسجيل بيع جديد</h3>

        <div className="space-y-4">
          <ProductSearchSelect value={selectedProduct} onChange={setSelectedProduct} />

          {selectedProduct && (
            <>
              <p className="text-sm text-text-secondary">
                المتوفر في المخزن: {selectedProduct.quantity} قطعة
              </p>

              <Input
                label="الكمية"
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                min={1}
                max={selectedProduct.quantity}
                error={
                  quantity > selectedProduct.quantity
                    ? `الحد الأقصى: ${selectedProduct.quantity}`
                    : undefined
                }
              />

              <Input
                label="سعر الوحدة (جنيه)"
                type="number"
                value={pricePerUnit}
                onChange={(e) => setPricePerUnit(Number(e.target.value))}
                min={1}
              />

              {/* Discount Section */}
              <div className="space-y-3 p-4 bg-gray-50 rounded-lg border border-gray-100">
                <p className="text-sm font-medium text-text-secondary">خصم (اختياري)</p>
                
                {/* Discount Type Toggle */}
                <div className="flex rounded-lg overflow-hidden border border-border">
                  <button
                    type="button"
                    onClick={() => setDiscountType("percentage")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors ${
                      discountType === "percentage"
                        ? "bg-accent text-white"
                        : "bg-white text-text-secondary hover:bg-gray-50"
                    }`}
                  >
                    <Percent className="w-4 h-4" />
                    نسبة مئوية
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiscountType("fixed")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors ${
                      discountType === "fixed"
                        ? "bg-accent text-white"
                        : "bg-white text-text-secondary hover:bg-gray-50"
                    }`}
                  >
                    <DollarSign className="w-4 h-4" />
                    مبلغ ثابت
                  </button>
                </div>

                {/* Discount Value Input */}
                <Input
                  label={discountType === "percentage" ? "نسبة الخصم (%)" : "مبلغ الخصم (جنيه)"}
                  type="number"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(Number(e.target.value))}
                  min={0}
                  max={discountType === "percentage" ? 100 : subtotal}
                />
              </div>

              {/* Price Breakdown */}
              <div className="p-4 bg-accent-light rounded-lg space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-text-secondary">المجموع الفرعي</span>
                  <span className="font-medium">{formatPrice(subtotal)}</span>
                </div>
                {discountAmount > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-danger">
                      الخصم {discountType === "percentage" ? `(${discountValue}%)` : ""}
                    </span>
                    <span className="font-medium text-danger">- {formatPrice(discountAmount)}</span>
                  </div>
                )}
                <div className="border-t border-accent/20 pt-2 flex items-center justify-between">
                  <span className="text-sm font-semibold">الإجمالي</span>
                  <span className="text-2xl font-bold text-accent">{formatPrice(totalPrice)}</span>
                </div>
              </div>

              <Input
                label="ملاحظة (اختياري)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="ملاحظة..."
              />

              <Button
                onClick={handleSubmit}
                disabled={!isValid}
                loading={loading}
                className="w-full"
              >
                تسجيل البيع
              </Button>
            </>
          )}
        </div>

        {/* Print Receipt Button — shows after successful sale */}
        {lastSale && (
          <div className="mt-4 pt-4 border-t border-border">
            <Button
              variant="secondary"
              onClick={handlePrint}
              className="w-full flex items-center justify-center gap-2"
            >
              <Printer className="w-5 h-5" />
              طباعة الفاتورة
            </Button>
          </div>
        )}
      </div>

      {/* Hidden Receipt for Printing */}
      {lastSale && (
        <div ref={receiptRef} className="print-receipt-container">
          <Receipt sale={lastSale} />
        </div>
      )}
    </>
  );
}