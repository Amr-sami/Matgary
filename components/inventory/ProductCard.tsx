"use client";

import { Pencil, Trash2, ShoppingCart, Plus, Minus } from "lucide-react";
import type { Product } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS, GENDER_LABELS } from "@/lib/types";
import { formatPrice, cn } from "@/lib/utils";

interface ProductCardProps {
  product: Product;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
  onSell: (product: Product) => void;
  onAdjustQty: (product: Product, delta: number) => void;
}

export function ProductCard({
  product,
  onEdit,
  onDelete,
  onSell,
  onAdjustQty,
}: ProductCardProps) {
  const isOutOfStock = product.quantity === 0;
  const isLowStock = product.quantity > 0 && product.quantity <= product.lowStockThreshold;
  const cost = product.costPrice || 0;
  const margin = product.price > 0 ? ((product.price - cost) / product.price) * 100 : 0;

  return (
    <div
      className={cn(
        "bg-white rounded-xl p-4 shadow-sm border border-border",
        isOutOfStock && "border-s-4 border-danger",
        isLowStock && "border-s-4 border-orange-300"
      )}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="font-medium">{product.name}</h3>
          {product.brand && (
            <p className="text-xs text-text-secondary">{product.brand}</p>
          )}
          <div className="flex flex-wrap gap-1 mt-1">
            {product.sku && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-text-secondary font-mono">
                {product.sku}
              </span>
            )}
            {product.location && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-text-secondary">
                📍 {product.location}
              </span>
            )}
          </div>
        </div>
        <Badge variant={product.category}>
          {CATEGORY_LABELS[product.category]}
        </Badge>
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge variant={product.gender}>
          {GENDER_LABELS[product.gender]}
        </Badge>
        {(product.tags || []).slice(0, 3).map((t) => (
          <span
            key={t}
            className="text-[10px] px-2 py-0.5 rounded-full bg-accent-light text-accent font-medium"
          >
            #{t}
          </span>
        ))}
        {cost > 0 && (
          <span
            className={cn(
              "text-xs font-medium px-2 py-0.5 rounded-md",
              margin < 15
                ? "bg-danger-light text-danger"
                : margin < 30
                  ? "bg-orange-50 text-orange-600"
                  : "bg-success-light text-success"
            )}
          >
            هامش {margin.toFixed(0)}%
          </span>
        )}
      </div>

      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-text-secondary mb-1">الكمية</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onAdjustQty(product, -1)}
              disabled={isOutOfStock}
              className="p-1 rounded-md border border-border disabled:opacity-30"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <span
              className={cn(
                "text-xl font-bold min-w-[2ch] text-center",
                isOutOfStock && "text-danger",
                isLowStock && "text-orange-600"
              )}
            >
              {product.quantity}
            </span>
            <button
              type="button"
              onClick={() => onAdjustQty(product, 1)}
              className="p-1 rounded-md border border-border"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="text-end">
          <p className="text-sm text-text-secondary">السعر</p>
          <p className="text-xl font-bold">{formatPrice(product.price)}</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onSell(product)}
          disabled={isOutOfStock}
          className="flex-1 flex items-center justify-center gap-2 py-2 bg-success-light text-success rounded-lg disabled:opacity-50"
        >
          <ShoppingCart className="w-4 h-4" />
          <span className="text-sm">بيع</span>
        </button>
        <button
          onClick={() => onEdit(product)}
          className="flex-1 flex items-center justify-center gap-2 py-2 bg-accent-light text-accent rounded-lg"
        >
          <Pencil className="w-4 h-4" />
          <span className="text-sm">تعديل</span>
        </button>
        <button
          onClick={() => onDelete(product)}
          className="p-2 bg-danger-light text-danger rounded-lg"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
