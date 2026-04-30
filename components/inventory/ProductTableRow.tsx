"use client";

import { Pencil, Trash2, ShoppingCart, Plus, Minus } from "lucide-react";
import type { Product } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS, GENDER_LABELS } from "@/lib/types";
import { formatPrice, cn } from "@/lib/utils";

interface ProductTableRowProps {
  product: Product;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
  onSell: (product: Product) => void;
  onAdjustQty: (product: Product, delta: number) => void;
  density: "comfortable" | "compact";
}

export function ProductTableRow({
  product,
  onEdit,
  onDelete,
  onSell,
  onAdjustQty,
  density,
  ...props
}: ProductTableRowProps) {
  const isOutOfStock = product.quantity === 0;
  const isLowStock = product.quantity > 0 && product.quantity <= product.lowStockThreshold;
  const cost = product.costPrice || 0;
  const profit = product.price - cost;
  const margin = product.price > 0 ? (profit / product.price) * 100 : 0;
  const stockValue = product.quantity * cost;

  const cellPad = density === "compact" ? "py-1.5 px-2" : "py-3 px-2";

  return (
    <tr
      className={cn(
        "border-b border-border last:border-0",
        isOutOfStock && "border-s-4 border-danger",
        isLowStock && "border-s-4 border-orange-300"
      )}
      {...props}
    >
      <td className={cellPad}>
        <div>
          <p className="font-medium">{product.name}</p>
          <div className="flex flex-wrap gap-1 mt-0.5">
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
            {(product.tags || []).slice(0, 3).map((t) => (
              <span
                key={t}
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent-light text-accent"
              >
                #{t}
              </span>
            ))}
          </div>
        </div>
      </td>
      <td className={cellPad}>
        <Badge variant={product.category}>{CATEGORY_LABELS[product.category]}</Badge>
      </td>
      <td className={cellPad}>
        <Badge variant={product.gender}>{GENDER_LABELS[product.gender]}</Badge>
      </td>
      <td className={cn(cellPad, "text-sm")}>{product.brand || "-"}</td>
      <td className={cellPad}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onAdjustQty(product, -1)}
            disabled={isOutOfStock}
            className="p-1 rounded-md hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed text-text-secondary"
            title="إنقاص"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <span
            className={cn(
              "font-medium min-w-[2ch] text-center",
              isOutOfStock && "text-danger",
              isLowStock && "text-orange-600"
            )}
          >
            {product.quantity}
          </span>
          <button
            type="button"
            onClick={() => onAdjustQty(product, 1)}
            className="p-1 rounded-md hover:bg-gray-100 text-text-secondary"
            title="زيادة"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
      <td className={cn(cellPad, "font-medium")}>{formatPrice(product.price)}</td>
      <td className={cn(cellPad, "text-sm")}>
        {cost > 0 ? (
          <span
            className={cn(
              "font-medium",
              margin < 15 ? "text-danger" : margin < 30 ? "text-orange-600" : "text-success"
            )}
          >
            {margin.toFixed(0)}%
          </span>
        ) : (
          <span className="text-text-secondary">-</span>
        )}
      </td>
      <td className={cn(cellPad, "text-sm")}>{formatPrice(stockValue)}</td>
      <td className={cn(cellPad, "text-xs text-text-secondary whitespace-nowrap")}>
        {product.updatedAt.toLocaleDateString("ar-EG", {
          year: "2-digit",
          month: "short",
          day: "numeric",
        })}
      </td>
      <td className={cellPad}>
        <div className="flex items-center gap-1">
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
