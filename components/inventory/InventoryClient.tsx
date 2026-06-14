"use client";

// Inventory client island. Owns the entire interactive surface:
// search, filters, sort, dead-stock toggle, pagination, bulk
// selection + actions, all 6 modals (edit, history, import, delete
// confirm, bulk delete confirm, scanner, quick-add), toast.
//
// Why this remains client (not split further): the filter/sort/
// paginate model runs IN-MEMORY over the full product list returned
// by useProducts. Lifting the table itself to a Server Component
// would require inlining the entire product payload (50K+ rows in
// production) into the page HTML — orders of magnitude bigger than
// the current client fetch. Documented as Wave 4 work: convert the
// page to cursor-paginated server reads + RSC table once the
// pagination contract is in place.
//
// What this conversion DOES win: the page wrapper (AppShell, title,
// dictionary resolution) now runs on the server, so the cashier's
// first-byte sees the page chrome immediately while the JS hydrates.

import { useState, useMemo, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Barcode, Download, LayoutGrid, Plus, Rows3, Upload, Skull } from "@/lib/icons";
import { BarcodeScannerModal } from "@/components/scanner/BarcodeScannerModal";
import { QuickAddProductModal } from "@/components/sales/QuickAddProductModal";
import { primeBeep } from "@/lib/scanner/beep";
import { markScan } from "@/lib/scanner/perf";
import { useProducts } from "@/hooks/useProducts";
import { useSales } from "@/hooks/useSales";
import { useSearch } from "@/hooks/useSearch";
import { InventoryFilters, type StockStatus } from "./InventoryFilters";
import { SortMenu, type SortKey } from "./SortMenu";
import { InventorySummary } from "./InventorySummary";
import { ProductTable } from "./ProductTable";
import { ProductCard } from "./ProductCard";
import { EditProductModal } from "./EditProductModal";
import { ProductHistoryModal } from "./ProductHistoryModal";
import { ImportProductsModal } from "./ImportProductsModal";
import { BulkActionsBar, type BulkAction } from "./BulkActionsBar";
import { Pagination } from "../ui/Pagination";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Toast } from "../ui/Toast";
import { PageSkeleton } from "../ui/PageSkeleton";
import { EmptyState } from "../ui/EmptyState";
import {
  deleteProduct,
  adjustProductQuantity,
  bulkDeleteProducts,
  bulkUpdateProducts,
} from "@/lib/api/products";
import { useCategories } from "@/hooks/useCategories";
import { productsToCsv, downloadCsv } from "@/lib/csv";
import type { Product, Category, Gender } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export function InventoryClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dict = useDictionary();
  const t = dict.app.inventory;
  const { products, loading, refresh: refreshProducts } = useProducts();
  const { sales } = useSales();
  const { byId: categoryById, data: categoryList } = useCategories();
  void categoryById;
  const { query, setQuery, filtered } = useSearch(products, [
    "name",
    "brand",
    "category",
    "sku",
    "tags",
    "supplier",
    "location",
  ]);

  // Deep-link from /sales scan-out-of-stock: `/inventory?q=<sku>`. We
  // apply the query once on mount so the cashier lands on the offending
  // product, then the user is free to clear / edit the search input.
  useEffect(() => {
    const q = searchParams.get("q");
    if (q && !query) setQuery(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selectedCategory, setSelectedCategory] = useState<Category | null>(
    (searchParams.get("cat") as Category | null) || null,
  );
  const [selectedGender, setSelectedGender] = useState<Gender | null>(
    (searchParams.get("gen") as Gender | null) || null,
  );
  const [selectedBrand, setSelectedBrand] = useState<string | null>(
    searchParams.get("brand") || null,
  );
  const [selectedStockStatus, setSelectedStockStatus] = useState<StockStatus | null>(
    (searchParams.get("stock") as StockStatus | null) || null,
  );
  const [selectedTag, setSelectedTag] = useState<string | null>(
    searchParams.get("tag") || null,
  );
  const [selectedSupplier, setSelectedSupplier] = useState<string | null>(
    searchParams.get("sup") || null,
  );
  const [minPrice, setMinPrice] = useState(searchParams.get("min") || "");
  const [maxPrice, setMaxPrice] = useState(searchParams.get("max") || "");
  const [sortKey, setSortKey] = useState<SortKey>(
    (searchParams.get("sort") as SortKey) || "newest",
  );
  const [density, setDensity] = useState<"comfortable" | "compact">(
    (searchParams.get("d") as "comfortable" | "compact") || "comfortable",
  );

  const [deadStockOnly, setDeadStockOnly] = useState(searchParams.get("dead") === "1");
  const [page, setPage] = useState(Number(searchParams.get("p") || "1"));
  const [pageSize, setPageSize] = useState(Number(searchParams.get("ps") || "50"));

  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [historyProduct, setHistoryProduct] = useState<Product | null>(null);
  const [deleteProductData, setDeleteProductData] = useState<Product | null>(null);
  const [_sellProduct, setSellProduct] = useState<Product | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddInitialSku, setQuickAddInitialSku] = useState("");
  const [bulkConfirm, setBulkConfirm] = useState<null | { count: number }>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Persist filter state in URL
  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedCategory) params.set("cat", selectedCategory);
    if (selectedGender) params.set("gen", selectedGender);
    if (selectedBrand) params.set("brand", selectedBrand);
    if (selectedStockStatus) params.set("stock", selectedStockStatus);
    if (selectedTag) params.set("tag", selectedTag);
    if (selectedSupplier) params.set("sup", selectedSupplier);
    if (minPrice) params.set("min", minPrice);
    if (maxPrice) params.set("max", maxPrice);
    if (sortKey !== "newest") params.set("sort", sortKey);
    if (density !== "comfortable") params.set("d", density);
    if (deadStockOnly) params.set("dead", "1");
    if (page !== 1) params.set("p", String(page));
    if (pageSize !== 50) params.set("ps", String(pageSize));
    const qs = params.toString();
    router.replace(qs ? `/inventory?${qs}` : "/inventory", { scroll: false });
  }, [
    selectedCategory,
    selectedGender,
    selectedBrand,
    selectedStockStatus,
    selectedTag,
    selectedSupplier,
    minPrice,
    maxPrice,
    sortKey,
    density,
    deadStockOnly,
    page,
    pageSize,
    router,
  ]);

  const recentlySoldIds = useMemo(() => {
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const set = new Set<string>();
    for (const s of sales) {
      if (!s.isReturned && s.saleDate.getTime() >= cutoff) {
        set.add(s.productId);
      }
    }
    return set;
  }, [sales]);

  const brands = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      if (p.brand && p.brand.trim()) set.add(p.brand.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ar"));
  }, [products]);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      for (const t of p.tags || []) {
        if (t && t.trim()) set.add(t.trim());
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ar"));
  }, [products]);

  const suppliers = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      if (p.supplier && p.supplier.trim()) set.add(p.supplier.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ar"));
  }, [products]);

  const genderOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      const g = p.attributes?.gender;
      if (g && g !== "—") set.add(g);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ar"));
  }, [products]);

  const filteredProducts = useMemo(() => {
    const min = minPrice ? Number(minPrice) : null;
    const max = maxPrice ? Number(maxPrice) : null;
    const result = filtered.filter((p) => {
      if (selectedCategory && p.category !== selectedCategory) return false;
      if (selectedGender && p.attributes?.gender !== selectedGender) return false;
      if (selectedBrand && p.brand !== selectedBrand) return false;
      if (selectedTag && !(p.tags || []).includes(selectedTag)) return false;
      if (selectedSupplier && p.supplier !== selectedSupplier) return false;
      if (selectedStockStatus) {
        if (selectedStockStatus === "out" && p.quantity !== 0) return false;
        if (
          selectedStockStatus === "low" &&
          !(p.quantity > 0 && p.quantity <= p.lowStockThreshold)
        )
          return false;
        if (selectedStockStatus === "in" && !(p.quantity > p.lowStockThreshold))
          return false;
      }
      if (min !== null && !Number.isNaN(min) && p.price < min) return false;
      if (max !== null && !Number.isNaN(max) && p.price > max) return false;
      if (deadStockOnly) {
        const ageDays = (Date.now() - p.createdAt.getTime()) / (24 * 60 * 60 * 1000);
        if (ageDays < 60) return false;
        if (recentlySoldIds.has(p.id)) return false;
        if (p.quantity === 0) return false;
      }
      return true;
    });

    const sorted = [...result];
    sorted.sort((a, b) => {
      const aMargin = a.price > 0 ? (a.price - (a.costPrice || 0)) / a.price : 0;
      const bMargin = b.price > 0 ? (b.price - (b.costPrice || 0)) / b.price : 0;
      switch (sortKey) {
        case "newest":
          return b.createdAt.getTime() - a.createdAt.getTime();
        case "oldest":
          return a.createdAt.getTime() - b.createdAt.getTime();
        case "name":
          return a.name.localeCompare(b.name, "ar");
        case "priceAsc":
          return a.price - b.price;
        case "priceDesc":
          return b.price - a.price;
        case "qtyAsc":
          return a.quantity - b.quantity;
        case "qtyDesc":
          return b.quantity - a.quantity;
        case "marginAsc":
          return aMargin - bMargin;
        case "marginDesc":
          return bMargin - aMargin;
      }
    });
    return sorted;
  }, [
    filtered,
    selectedCategory,
    selectedGender,
    selectedBrand,
    selectedTag,
    selectedSupplier,
    selectedStockStatus,
    minPrice,
    maxPrice,
    sortKey,
    deadStockOnly,
    recentlySoldIds,
  ]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [filteredProducts.length, pageSize, page]);

  const pagedProducts = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredProducts.slice(start, start + pageSize);
  }, [filteredProducts, page, pageSize]);

  const selectedProducts = useMemo(
    () => filteredProducts.filter((p) => selectedIds.has(p.id)),
    [filteredProducts, selectedIds],
  );

  const toggleSelect = useCallback((product: Product) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(product.id)) next.delete(product.id);
      else next.add(product.id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allOnPage = pagedProducts.every((p) => prev.has(p.id));
      const next = new Set(prev);
      if (allOnPage) {
        for (const p of pagedProducts) next.delete(p.id);
      } else {
        for (const p of pagedProducts) next.add(p.id);
      }
      return next;
    });
  }, [pagedProducts]);

  const handleDelete = async () => {
    if (!deleteProductData) return;
    try {
      await deleteProduct(deleteProductData.id);
      setToast({ type: "success", message: t.toast.productDeleted });
      await refreshProducts();
    } catch (error: any) {
      setToast({ type: "error", message: error.message || t.toast.deleteFailed });
    }
  };

  const handleSell = (product: Product) => {
    setSellProduct(product);
    router.push(`/sales?preselect=${encodeURIComponent(product.id)}`);
  };

  const handleAdjustQty = useCallback(
    async (product: Product, delta: number) => {
      try {
        const next = await adjustProductQuantity(product.id, delta);
        setToast({
          type: "success",
          message: t.toast.qtyAdjusted
            .replace("{name}", product.name)
            .replace("{n}", String(next)),
        });
        await refreshProducts();
      } catch (error: any) {
        setToast({ type: "error", message: error.message || t.toast.qtyAdjustFailed });
      }
    },
    [refreshProducts, t.toast],
  );

  const handleExportCsv = useCallback(() => {
    const csv = productsToCsv(filteredProducts);
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(`inventory-${date}.csv`, csv);
  }, [filteredProducts]);

  const handleBulkAction = useCallback(
    async (action: BulkAction) => {
      const ids = Array.from(selectedIds);
      const items = filteredProducts.filter((p) => selectedIds.has(p.id));
      if (items.length === 0) return;
      const n = String(items.length);
      try {
        switch (action.type) {
          case "delete":
            setBulkConfirm({ count: ids.length });
            return;
          case "addTag":
            await bulkUpdateProducts(items, { type: "addTag", value: action.tag });
            setToast({ type: "success", message: t.toast.tagAdded.replace("{n}", n) });
            break;
          case "priceMultiplier":
            await bulkUpdateProducts(items, {
              type: "priceMultiplier",
              value: action.multiplier,
            });
            setToast({ type: "success", message: t.toast.priceUpdated.replace("{n}", n) });
            break;
          case "category":
            await bulkUpdateProducts(items, { type: "category", value: action.value });
            setToast({ type: "success", message: t.toast.categoryUpdated.replace("{n}", n) });
            break;
          case "gender":
            await bulkUpdateProducts(items, { type: "gender", value: action.value });
            setToast({ type: "success", message: t.toast.genderUpdated.replace("{n}", n) });
            break;
          case "supplier":
            await bulkUpdateProducts(items, { type: "supplier", value: action.value });
            setToast({ type: "success", message: t.toast.supplierUpdated.replace("{n}", n) });
            break;
          case "location":
            await bulkUpdateProducts(items, { type: "location", value: action.value });
            setToast({ type: "success", message: t.toast.locationUpdated.replace("{n}", n) });
            break;
          case "exportCsv": {
            const csv = productsToCsv(items);
            const date = new Date().toISOString().slice(0, 10);
            downloadCsv(`inventory-selected-${date}.csv`, csv);
            break;
          }
        }
        await refreshProducts();
      } catch (e: any) {
        setToast({ type: "error", message: e.message || t.toast.actionFailed });
      }
    },
    [selectedIds, filteredProducts, refreshProducts, t.toast],
  );

  const handleBulkDeleteConfirm = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await bulkDeleteProducts(ids);
      setSelectedIds(new Set());
      setToast({
        type: "success",
        message: t.toast.bulkDeleted.replace("{n}", String(ids.length)),
      });
      await refreshProducts();
    } catch (e: any) {
      setToast({ type: "error", message: e.message || t.toast.bulkDeleteFailed });
    } finally {
      setBulkConfirm(null);
    }
  }, [selectedIds, t.toast]);

  const hasAnyFilter =
    !!selectedCategory ||
    !!selectedGender ||
    !!selectedBrand ||
    !!selectedTag ||
    !!selectedSupplier ||
    !!selectedStockStatus ||
    !!minPrice ||
    !!maxPrice ||
    !!query ||
    deadStockOnly;

  const handleResetFilters = () => {
    setSelectedCategory(null);
    setSelectedGender(null);
    setSelectedBrand(null);
    setSelectedTag(null);
    setSelectedSupplier(null);
    setSelectedStockStatus(null);
    setMinPrice("");
    setMaxPrice("");
    setQuery("");
    setDeadStockOnly(false);
  };

  if (loading) {
    return <PageSkeleton variant="grid" rows={8} cards={false} />;
  }

  return (
    <>
      <div className="space-y-4">
        <InventorySummary
          products={products}
          onFilterLow={() => setSelectedStockStatus("low")}
          onFilterOut={() => setSelectedStockStatus("out")}
        />

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder={t.search.placeholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pe-14 px-4 py-3 rounded-xl border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="button"
              onClick={() => {
                markScan("click");
                primeBeep();
                setScannerOpen(true);
              }}
              aria-label={t.tools.scanAriaLabel}
              className="absolute end-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-10 h-10 rounded-lg text-accent hover:bg-accent-light/60 transition-colors"
            >
              <Barcode className="w-5 h-5" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setQuickAddInitialSku("");
              setQuickAddOpen(true);
            }}
            className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-accent text-white font-semibold hover:opacity-90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>{t.tools.addProduct}</span>
          </button>
        </div>

        <InventoryFilters
          categoryOptions={categoryList}
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          genderOptions={genderOptions}
          selectedGender={selectedGender}
          onGenderChange={setSelectedGender}
          selectedBrand={selectedBrand}
          onBrandChange={setSelectedBrand}
          brands={brands}
          selectedStockStatus={selectedStockStatus}
          onStockStatusChange={setSelectedStockStatus}
          minPrice={minPrice}
          maxPrice={maxPrice}
          onMinPriceChange={setMinPrice}
          onMaxPriceChange={setMaxPrice}
          tags={tags}
          selectedTag={selectedTag}
          onTagChange={setSelectedTag}
          suppliers={suppliers}
          selectedSupplier={selectedSupplier}
          onSupplierChange={setSelectedSupplier}
        />

        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <SortMenu value={sortKey} onChange={setSortKey} />
            <button
              onClick={() => setDeadStockOnly(!deadStockOnly)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors ${
                deadStockOnly
                  ? "bg-orange-100 border-orange-300 text-orange-700"
                  : "border-border bg-white text-text-secondary hover:border-accent"
              }`}
              title={t.tools.deadStockTitle}
            >
              <Skull className="w-4 h-4" />
              {t.tools.deadStock}
            </button>
            {hasAnyFilter && (
              <button
                onClick={handleResetFilters}
                className="px-3 py-2 rounded-lg text-sm text-text-secondary hover:text-accent border border-border bg-white"
              >
                {t.tools.clearFilters}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
              className="hidden md:flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-border bg-white text-text-secondary hover:border-accent"
              title={t.tools.densityTitle}
            >
              {density === "compact" ? <Rows3 className="w-4 h-4" /> : <LayoutGrid className="w-4 h-4" />}
              {density === "compact" ? t.tools.comfortable : t.tools.compact}
            </button>
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-border bg-white text-text-secondary hover:border-accent"
            >
              <Upload className="w-4 h-4" />
              {t.tools.import}
            </button>
            <button
              onClick={handleExportCsv}
              disabled={filteredProducts.length === 0}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-border bg-white text-text-secondary hover:border-accent disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              {t.tools.exportCsv}
            </button>
          </div>
        </div>

        <BulkActionsBar
          selected={selectedProducts}
          onClear={() => setSelectedIds(new Set())}
          onAction={handleBulkAction}
        />

        <p className="text-sm text-text-secondary">
          {t.count.replace("{n}", String(filteredProducts.length))}
        </p>

        {filteredProducts.length === 0 && (
          <div className="space-y-3">
            <EmptyState
              type="products"
              message={
                query
                  ? t.empty.search.replace("{q}", query)
                  : hasAnyFilter
                    ? t.empty.filters
                    : t.empty.fresh
              }
            />
            {query.trim().length > 0 && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    setQuickAddInitialSku(query.trim());
                    setQuickAddOpen(true);
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-accent text-white text-sm font-semibold hover:opacity-90 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  {t.empty.createWithCode.replace("{code}", query.trim())}
                </button>
              </div>
            )}
          </div>
        )}

        {filteredProducts.length > 0 && (
          <div className="hidden md:block">
            <ProductTable
              products={pagedProducts}
              onEdit={setEditProduct}
              onDelete={setDeleteProductData}
              onSell={handleSell}
              onAdjustQty={handleAdjustQty}
              onHistory={setHistoryProduct}
              density={density}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
            />
          </div>
        )}

        {filteredProducts.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:hidden">
            {pagedProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onEdit={setEditProduct}
                onDelete={setDeleteProductData}
                onSell={handleSell}
                onAdjustQty={handleAdjustQty}
                onHistory={setHistoryProduct}
                selected={selectedIds.has(product.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        )}

        {filteredProducts.length > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={filteredProducts.length}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        )}
      </div>

      <EditProductModal
        isOpen={!!editProduct}
        onClose={() => setEditProduct(null)}
        product={editProduct}
        onSuccess={async () => {
          await refreshProducts();
          setToast({ type: "success", message: t.toast.productUpdated });
        }}
      />

      <ProductHistoryModal
        isOpen={!!historyProduct}
        onClose={() => setHistoryProduct(null)}
        product={historyProduct}
      />

      <ImportProductsModal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={async () => {
          await refreshProducts();
          setToast({ type: "success", message: t.toast.importRefreshed });
        }}
      />

      <ConfirmDialog
        isOpen={!!deleteProductData}
        onClose={() => setDeleteProductData(null)}
        onConfirm={handleDelete}
        title={t.confirmDelete.title}
        message={t.confirmDelete.message.replace("{name}", deleteProductData?.name || "")}
        confirmText={t.confirmDelete.confirm}
        variant="danger"
      />

      <ConfirmDialog
        isOpen={!!bulkConfirm}
        onClose={() => setBulkConfirm(null)}
        onConfirm={handleBulkDeleteConfirm}
        title={t.confirmBulkDelete.title}
        message={t.confirmBulkDelete.message.replace("{n}", String(bulkConfirm?.count || 0))}
        confirmText={t.confirmBulkDelete.confirm}
        variant="danger"
      />

      <BarcodeScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={(code) => {
          setQuery(code);
          setScannerOpen(false);
        }}
      />

      <QuickAddProductModal
        isOpen={quickAddOpen}
        onClose={() => {
          setQuickAddOpen(false);
          setQuickAddInitialSku("");
        }}
        initialSku={quickAddInitialSku}
        onCreated={async () => {
          await refreshProducts();
          setQuery("");
          setToast({ type: "success", message: t.toast.productAdded });
        }}
      />

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </>
  );
}
