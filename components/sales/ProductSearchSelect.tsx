"use client";

import { useState, useRef, useEffect } from "react";
import { Barcode, Search, X } from "@/lib/icons";
import { useProducts } from "@/hooks/useProducts";
import type { Product } from "@/lib/types";
import { Badge } from "../ui/Badge";
import { CATEGORY_LABELS } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { QuickAddProductModal } from "./QuickAddProductModal";
import { BarcodeScannerModal } from "../scanner/BarcodeScannerModal";
import { resolveScannedSku } from "@/lib/sales/scan-cart";
import { primeBeep } from "@/lib/scanner/beep";

interface ProductSearchSelectProps {
  value: Product | null;
  onChange: (product: Product | null) => void;
  /** Optional scan path. When the cashier scans a barcode and exactly one
   *  product matches, the parent gets `onScan(product)` instead of
   *  `onChange`. This lets the POS merge into an existing cart line
   *  (qty + 1) instead of replacing the current selection. If omitted,
   *  scan falls back to onChange. */
  onScan?: (product: Product) => void;
}

export function ProductSearchSelect({ value, onChange, onScan }: ProductSearchSelectProps) {
  const dict = useDictionary();
  const t = dict.app.sales.form.productSearch;
  const { products, refresh: refreshProducts } = useProducts();
  const [search, setSearch] = useState("");
  // Quick-add modal — lets the cashier add a brand-new product to the
  // catalog without leaving the register. The new product joins inventory
  // immediately and is auto-selected for the current sale.
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  // Pre-fill the SKU in QuickAdd when triggered by a scan-not-found. Stays
  // empty for the legacy "no match while typing a name" entry point.
  const [quickAddInitialSku, setQuickAddInitialSku] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  // Inline banner that appears above the dropdown when a scan returns
  // zero matches. Cleared on close, dismiss, or next scan.
  const [scanNotFoundCode, setScanNotFoundCode] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Scan-aware filter — now matches name, brand AND sku. Sku is
  // case-insensitive and trimmed (manufacturers' barcodes are alphanum
  // with no whitespace, but defensive anyway).
  const filteredProducts = products.filter((p) => {
    if (p.quantity <= 0) return false;
    const q = search.trim().toLowerCase();
    if (!q) return false;
    return (
      p.name.toLowerCase().includes(q) ||
      p.brand?.toLowerCase().includes(q) ||
      p.sku?.toLowerCase().includes(q)
    );
  });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Sync the input with the parent-controlled selection. When the parent
  // clears `value` (e.g. after add-to-cart), drop the search text so the
  // user can type the next product immediately. When the parent sets a new
  // value (e.g. quick-pick from "recent products"), reflect its name.
  useEffect(() => {
    if (value === null) {
      setSearch("");
      setIsOpen(false);
    } else if (search !== value.name) {
      setSearch(value.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleSelect = (product: Product) => {
    onChange(product);
    setSearch(product.name);
    setIsOpen(false);
  };

  // Resolves a scanned code (or a manually-typed barcode from the scanner
  // modal's fallback input) against the catalog. Exact SKU match wins
  // over substring matches; we only consider in-stock products to avoid
  // surfacing items the cashier can't sell anyway.
  const resolveScannedCode = (code: string) => {
    setScannerOpen(false);
    setScanNotFoundCode(null);

    const resolution = resolveScannedSku(products, code);
    if (resolution.kind === "found") {
      const product = resolution.product;
      if (onScan) {
        onScan(product);
        // POS scan flow: caller handles cart merge; we clear our own state.
        setSearch("");
        setIsOpen(false);
      } else {
        handleSelect(product);
      }
      return;
    }

    if (resolution.kind === "not-found") {
      if (!resolution.code) return;
      // Surface "not found" inline + open the dropdown so the cashier sees
      // the Create CTA. We DON'T auto-open QuickAdd: the cashier might
      // have misread the barcode and want to scan again.
      setSearch(resolution.code);
      setScanNotFoundCode(resolution.code);
      setIsOpen(true);
      return;
    }

    // Multiple in-stock products share this SKU. Use the existing dropdown
    // to let the cashier pick (the search filter already includes sku, so
    // setting search = code naturally shows just the matching rows).
    setSearch(resolution.matches[0]!.sku ?? code);
    setIsOpen(true);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-sm font-medium text-text-secondary mb-1.5">
        {t.label}
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
            setScanNotFoundCode(null);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={t.placeholder}
          className="w-full ps-12 pe-20 py-3 rounded-lg border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setSearch("");
            }}
            className="absolute end-12 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            primeBeep();
            setScannerOpen(true);
          }}
          aria-label={t.scanAriaLabel}
          className="absolute end-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-9 h-9 rounded-lg text-accent hover:bg-accent-light/60 transition-colors"
        >
          <Barcode className="w-5 h-5" />
        </button>
      </div>

      {isOpen && (filteredProducts.length > 0 || search.trim().length > 0 || scanNotFoundCode) && (
        <div className="absolute top-full start-0 end-0 mt-1 bg-white border border-border rounded-lg shadow-lg max-h-72 overflow-y-auto z-50">
          {scanNotFoundCode && (
            <div className="px-4 py-3 bg-warning-light/30 border-b border-border">
              <p className="text-sm text-text-primary">
                {t.scannedNotFound.replace("{code}", scanNotFoundCode)}
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuickAddInitialSku(scanNotFoundCode);
                  setScanNotFoundCode(null);
                  setIsOpen(false);
                  setQuickAddOpen(true);
                }}
                className="mt-1.5 text-sm font-semibold text-accent hover:underline"
              >
                {t.scannedNotFoundCreate}
              </button>
            </div>
          )}

          {filteredProducts.slice(0, 10).map((product) => (
            <button
              key={product.id}
              onClick={() => handleSelect(product)}
              className="w-full px-4 py-3 text-start hover:bg-gray-50 border-b border-border last:border-0"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium" dir="auto">
                    {product.name}
                  </p>
                  {product.brand && (
                    <p className="text-xs text-text-secondary" dir="auto">
                      {product.brand}
                    </p>
                  )}
                </div>
                <div className="text-end">
                  <Badge variant={product.category}>
                    {CATEGORY_LABELS[product.category]}
                  </Badge>
                  <p className="text-xs text-text-secondary mt-1">
                    {t.inStock.replace("{n}", String(product.quantity))}
                  </p>
                </div>
              </div>
            </button>
          ))}

          {/* Quick-add CTA. Renders when the user has typed something
              (so we have a name to pre-fill); the label flips to a
              "no match" hint when the typed name doesn't match any
              existing product. Hidden when the scan-not-found banner
              is showing its own create CTA. */}
          {!scanNotFoundCode && search.trim().length > 0 && (
            <button
              onClick={() => {
                setQuickAddInitialSku("");
                setIsOpen(false);
                setQuickAddOpen(true);
              }}
              className={`w-full px-4 py-3 text-start hover:bg-accent-light/40 border-t border-border ${
                filteredProducts.length === 0 ? "text-accent" : "text-text-primary"
              }`}
            >
              <p className="font-medium text-sm" dir="auto">
                {filteredProducts.length === 0
                  ? t.addNewWithName.replace("{name}", search.trim())
                  : t.addNew}
              </p>
              {filteredProducts.length === 0 && (
                <p className="text-xs text-text-secondary mt-0.5">{t.noMatch}</p>
              )}
            </button>
          )}
        </div>
      )}

      <QuickAddProductModal
        isOpen={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        initialName={quickAddInitialSku ? "" : search}
        initialSku={quickAddInitialSku}
        onCreated={async (productId) => {
          // Re-fetch the catalog so the new product appears in every
          // useProducts consumer (inventory page, stats grid, etc.), AND
          // auto-select it for the current cart line. refresh() returns
          // the fresh array so we don't race React's state commit.
          const freshList = await refreshProducts();
          const fresh = freshList.find((p) => p.id === productId);
          if (fresh) {
            if (quickAddInitialSku && onScan) {
              // The cashier just scanned an unknown barcode and chose to
              // create it. Route through the scan path so cart-merge
              // semantics apply (qty + 1 if scanned again later).
              onScan(fresh);
              setSearch("");
            } else {
              onChange(fresh);
              setSearch(fresh.name);
            }
          }
          setQuickAddInitialSku("");
        }}
      />

      <BarcodeScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={resolveScannedCode}
      />
    </div>
  );
}
