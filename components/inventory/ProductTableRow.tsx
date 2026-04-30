"use client";

import { Pencil, Trash2, ShoppingCart } from "lucide-react";
import type { Product } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS, GENDER_LABELS } from "@/lib/types";
import { formatPrice, cn } from "@/lib/utils";

interface ProductTableRowProps {
  product: Product;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
  onSell: (product: Product) => void;
}

export function ProductTableRow({ product, onEdit, onDelete, onSell, ...props }: ProductTableRowProps) {
  const isOutOfStock = product.quantity === 0;
  const isLowStock = product.quantity > 0 && product.quantity <= product.lowStockThreshold;

  return (
    <tr
      className={cn(
        "border-b border-border last:border-0",
        isOutOfStock && "border-s-4 border-danger",
        isLowStock && "border-s-4 border-orange-300"
      )}
      {...props}
    >
      <td className="py-3 px-2">
        <div>
          <p className="font-medium">{product.name}</p>
          {product.brand && (
            <p className="text-xs text-text-secondary">{product.brand}</p>
          )}
        </div>
      </td>
      <td className="py-3 px-2">
        <Badge variant={product.category}>{CATEGORY_LABELS[product.category]}</Badge>
      </td>
      <td className="py-3 px-2">
        <Badge variant={product.gender}>{GENDER_LABELS[product.gender]}</Badge>
      </td>
      <td className="py-3 px-2 text-sm">{product.brand || "-"}</td>
      <td className="py-3 px-2">
        <span
          className={cn(
            "font-medium",
            isOutOfStock && "text-danger",
            isLowStock && "text-orange-600"
          )}
        >
          {product.quantity}
        </span>
      </td>
      <td className="py-3 px-2 font-medium">{formatPrice(product.price)}</td>
      <td className="py-3 px-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSell(product)}
            disabled={isOutOfStock}
            className="p-2 hover:bg-success-light rounded-lg text-success disabled:opacity-50 disabled:cursor-not-allowed"
            title="بيع"
          >
            <ShoppingCart className="w-4 h-4" />
          </button>
          <button
            onClick={() => onEdit(product)}
            className="p-2 hover:bg-accent-light rounded-lg text-accent"
            title="تعديل"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(product)}
            className="p-2 hover:bg-danger-light rounded-lg text-danger"
            title="حذف"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}