"use client";

import { Pencil, Trash2, ShoppingCart, Plus, Minus, History } from "@/lib/icons";
import type { Product } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { useCatalog } from "@/components/catalog-context";
import { cn } from "@/lib/utils";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface ProductTableRowProps {
  product: Product;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
  onSell: (product: Product) => void;
  onAdjustQty: (product: Product, delta: number) => void;
  onHistory: (product: Product) => void;
  density: "comfortable" | "compact";
  selected: boolean;
  onToggleSelect: (product: Product) => void;
}

export function ProductTableRow({
  product,
  onEdit,
  onDelete,
  onSell,
  onAdjustQty,
  onHistory,
  density,
  selected,
  onToggleSelect,
  ...props
}: ProductTableRowProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.inventory.table.actions;
  const isOutOfStock = product.quantity === 0;
  const isLowStock = product.quantity > 0 && product.quantity <= product.lowStockThreshold;
  const cost = product.costPrice || 0;
  const profit = product.price - cost;
  const margin = product.price > 0 ? (profit / product.price) * 100 : 0;
  const stockValue = product.quantity * cost;

  const cellPad = density === "compact" ? "py-1.5 px-2" : "py-3 px-2";
  const { categoryLabel, attributeLabel, categoryById } = useCatalog();
  const cat = categoryById[product.category];
  const genderLabel = attributeLabel(product, "gender");
  const updatedAtLabel = product.updatedAt.toLocaleDateString(
    locale === "en" ? "en-EG" : "ar-EG",
    {
      year: "2-digit",
      month: "short",
      day: "numeric",
      numberingSystem: "latn",
    } as Intl.DateTimeFormatOptions,
  );

  return (
    <tr
      className={cn(
        "border-b border-border last:border-0",
        selected && "bg-accent-light/40",
        isOutOfStock && "border-s-4 border-danger",
        isLowStock && "border-s-4 border-orange-300"
      )}
      {...props}
    >
      <td className={cn(cellPad, "w-8")}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(product)}
          className="w-4 h-4 accent-accent cursor-pointer"
        />
      </td>
      <td className={cellPad}>
        <div>
          <p className="font-medium" dir="auto">{product.name}</p>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {product.sku && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-text-secondary font-mono">
                {product.sku}
              </span>
            )}
            {product.location && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-text-secondary" dir="auto">
                📍 {product.location}
              </span>
            )}
            {(product.tags || []).slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent-light text-accent"
                dir="auto"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>
      </td>
      <td className={cellPad}>
        <Badge variant={cat?.key as "watches" | "perfumes" | "sunglasses" | undefined}>
          {categoryLabel(product)}
        </Badge>
      </td>
      <td className={cellPad}>
        {genderLabel && genderLabel !== "—" ? (
          <Badge variant={product.attributes?.gender === "رجالي" ? "male" : "female"}>
            {genderLabel}
          </Badge>
        ) : (
          <span className="text-text-secondary text-sm">—</span>
        )}
      </td>
      <td className={cn(cellPad, "text-sm")} dir="auto">{product.brand || "-"}</td>
      <td className={cellPad}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onAdjustQty(product, -1)}
            disabled={isOutOfStock}
            className="p-1 rounded-md hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed text-text-secondary"
            title={t.decrease}
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
            title={t.increase}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
      <td className={cn(cellPad, "font-medium")}>{formatCurrency(product.price, locale)}</td>
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
      <td className={cn(cellPad, "text-sm")}>{formatCurrency(stockValue, locale)}</td>
      <td className={cn(cellPad, "text-xs text-text-secondary whitespace-nowrap")}>
        {updatedAtLabel}
      </td>
      <td className={cellPad}>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onSell(product)}
            disabled={isOutOfStock}
            className="p-2 rounded-lg text-success hover:opacity-70 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
            title={t.sell}
          >
            <ShoppingCart className="w-4 h-4" />
          </button>
          <button
            onClick={() => onEdit(product)}
            className="p-2 rounded-lg text-accent hover:opacity-70 transition-opacity"
            title={t.edit}
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={() => onHistory(product)}
            className="p-2 rounded-lg text-text-secondary hover:opacity-70 transition-opacity"
            title={t.history}
          >
            <History className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(product)}
            className="p-2 rounded-lg text-danger hover:opacity-70 transition-opacity"
            title={t.delete}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}
