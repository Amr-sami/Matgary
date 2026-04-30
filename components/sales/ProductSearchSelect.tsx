"use client";

import { useState, useRef, useEffect } from "react";
import { Search, X } from "lucide-react";
import { useProducts } from "@/hooks/useProducts";
import type { Product } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS } from "@/lib/types";

interface ProductSearchSelectProps {
  value: Product | null;
  onChange: (product: Product | null) => void;
}

export function ProductSearchSelect({ value, onChange }: ProductSearchSelectProps) {
  const { products } = useProducts();
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const filteredProducts = products.filter(
    (p) =>
      p.quantity > 0 &&
      (p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.brand?.toLowerCase().includes(search.toLowerCase()))
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (product: Product) => {
    onChange(product);
    setSearch(product.name);
    setIsOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-sm font-medium text-text-secondary mb-1.5">
        اختيار المنتج
      </label>
      <div className="relative">
        <Search className="absolute start-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
        <input
          id="sale-product-search"
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder="ابحث عن منتج..."
          dir="rtl"
          className="w-full ps-12 pe-10 py-3 rounded-lg border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent"
        />
        {value && (
          <button
            onClick={() => {
              onChange(null);
              setSearch("");
            }}
            className="absolute end-4 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {isOpen && filteredProducts.length > 0 && (
        <div className="absolute top-full start-0 end-0 mt-1 bg-white border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto z-50">
          {filteredProducts.slice(0, 10).map((product) => (
            <button
              key={product.id}
              onClick={() => handleSelect(product)}
              className="w-full px-4 py-3 text-start hover:bg-gray-50 border-b border-border last:border-0"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{product.name}</p>
                  {product.brand && (
                    <p className="text-xs text-text-secondary">{product.brand}</p>
                  )}
                </div>
                <div className="text-end">
                  <Badge variant={product.category}>
                    {CATEGORY_LABELS[product.category]}
                  </Badge>
                  <p className="text-xs text-text-secondary mt-1">
                    متوفر: {product.quantity}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}