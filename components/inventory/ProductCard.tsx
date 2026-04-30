"use client";

import { Pencil, Trash2, ShoppingCart } from "lucide-react";
import type { Product } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS, GENDER_LABELS } from "@/lib/types";
import { formatPrice, cn } from "@/lib/utils";

interface ProductCardProps {
  product: Product;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
  onSell: (product: Product) => void;
}

export function ProductCard({ product, onEdit, onDelete, onSell }: ProductCardProps) {
  const isOutOfStock = product.quantity === 0;
  const isLowStock = product.quantity > 0 && product.quantity <= product.lowStockThreshold;

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
        </div>
        <Badge variant={product.category}>
          {CATEGORY_LABELS[product.category]}
        </Badge>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <Badge variant={product.gender}>
          {GENDER_LABELS[product.gender]}
        </Badge>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-text-secondary">الكمية</p>
          <p
            className={cn(
              "text-xl font-bold",
              isOutOfStock && "text-danger",
              isLowStock && "text-orange-600"
            )}
          >
            {product.quantity}
          </p>
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