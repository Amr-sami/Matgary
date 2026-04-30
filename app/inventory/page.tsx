"use client";

import { useState, useMemo, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, LayoutGrid, Rows3, Upload, Skull } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { useProducts } from "@/hooks/useProducts";
import { useSales } from "@/hooks/useSales";
import { useSearch } from "@/hooks/useSearch";
import { InventoryFilters, type StockStatus } from "@/components/inventory/InventoryFilters";
import { SortMenu, type SortKey } from "@/components/inventory/SortMenu";
import { InventorySummary } from "@/components/inventory/InventorySummary";
import { ProductTable } from "@/components/inventory/ProductTable";
import { ProductCard } from "@/components/inventory/ProductCard";
import { EditProductModal } from "@/components/inventory/EditProductModal";
import { ProductHistoryModal } from "@/components/inventory/ProductHistoryModal";
import { CsvImportModal } from "@/components/inventory/CsvImportModal";
import {
  BulkActionsBar,
  type BulkAction,
} from "@/components/inventory/BulkActionsBar";
import { Pagination } from "@/components/ui/Pagination";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Toast } from "@/components/ui/Toast";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  deleteProduct,
  adjustProductQuantity,
  bulkDeleteProducts,
  bulkUpdateProducts,
} from "@/lib/firestore";
import { productsToCsv, downloadCsv } from "@/lib/csv";
import type { Product, Category, Gender } from "@/lib/types";

export default function InventoryPage() {
  return (
    <Suspense
      fallback={
        <AppShell title="المخزن">
          <div className="flex items-center justify-center py-20">
            <LoadingSpinner />
          </div>
        </AppShell>
      }
    >
      <InventoryPageInner />
    </Suspense>
  );
}

function InventoryPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { products, loading } = useProducts();
  const { sales } = useSales();
  const { query, setQuery, filtered } = useSearch(products, [
    "name",
    "brand",
    "category",
    "sku",
    "tags",
    "supplier",
    "location",
  ]);

  const [selectedCategory, setSelectedCategory] = useState<Category | null>(
    (searchParams.get("cat") as Category | null) || null
  );
  const [selectedGender, setSelectedGender] = useState<Gender | null>(
    (searchParams.get("gen") as Gender | null) || null
  );
  const [selectedBrand, setSelectedBrand] = useState<string | null>(
    searchParams.get("brand") || null
  );
  const [selectedStockStatus, setSelectedStockStatus] = useState<StockStatus | null>(
    (searchParams.get("stock") as StockStatus | null) || null
  );
  const [selectedTag, setSelectedTag] = useState<string | null>(
    searchParams.get("tag") || null
  );
  const [selectedSupplier, setSelectedSupplier] = useState<string | null>(
    searchParams.get("sup") || null
  );
  const [minPrice, setMinPrice] = useState(searchParams.get("min") || "");
  const [maxPrice, setMaxPrice] = useState(searchParams.get("max") || "");
  const [sortKey, setSortKey] = useState<SortKey>(
    (searchParams.get("sort") as SortKey) || "newest"
  );
  const [density, setDensity] = useState<"comfortable" | "compact">(
    (searchParams.get("d") as "comfortable" | "compact") || "comfortable"
  );

  const [deadStockOnly, setDeadStockOnly] = useState(searchParams.get("dead") === "1");
  const [page, setPage] = useState(Number(searchParams.get("p") || "1"));
  const [pageSize, setPageSize] = useState(Number(searchParams.get("ps") || "50"));

  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [historyProduct, setHistoryProduct] = useState<Product | null>(null);
  const [deleteProductData, setDeleteProductData] = useState<Product | null>(null);
  const [_sellProduct, setSellProduct] = useState<Product | null>(null);
  const [importOpen, setImportOpen] = useState(false);
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

  // Track which product IDs sold in the last 60 days for dead-stock detection
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

  // Build the dynamic brand list from real data
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

  const filteredProducts = useMemo(() => {
    const min = minPrice ? Number(minPrice) : null;
    const max = maxPrice ? Number(maxPrice) : null;
    const result = filtered.filter((p) => {
      if (selectedCategory && p.category !== selectedCategory) return false;
      if (selectedGender && p.gender !== selectedGender) return false;
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

  // Reset page when result count drops below current page
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
    [filteredProducts, selectedIds]
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
      setToast({ type: "success", message: "تم حذف المنتج بنجاح" });
    } catch (error: any) {
      setToast({ type: "error", message: error.message || "حدث خطأ" });
    }
  };

  const handleSell = (product: Product) => {
    setSellProduct(product);
  };

  const handleAdjustQty = useCallback(
    async (product: Product, delta: number) => {
      try {
        const next = await adjustProductQuantity(product.id, delta);
        setToast({
          type: "success",
          message: `تم تعديل كمية "${product.name}" إلى ${next}`,
        });
      } catch (error: any) {
        setToast({ type: "error", message: error.message || "تعذر تعديل الكمية" });
      }
    },
    []
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
      try {
        switch (action.type) {
          case "delete":
            setBulkConfirm({ count: ids.length });
            return;
          case "addTag":
            await bulkUpdateProducts(items, { type: "addTag", value: action.tag });
            setToast({ type: "success", message: `تمت إضافة التاج لـ ${items.length} منتج` });
            break;
          case "priceMultiplier":
            await bulkUpdateProducts(items, {
              type: "priceMultiplier",
              value: action.multiplier,
            });
            setToast({ type: "success", message: `تم تعديل سعر ${items.length} منتج` });
            break;
          case "category":
            await bulkUpdateProducts(items, { type: "category", value: action.value });
            setToast({ type: "success", message: `تم تغيير الصنف لـ ${items.length} منتج` });
            break;
          case "gender":
            await bulkUpdateProducts(items, { type: "gender", value: action.value });
            setToast({ type: "success", message: `تم تغيير النوع لـ ${items.length} منتج` });
            break;
          case "supplier":
            await bulkUpdateProducts(items, { type: "supplier", value: action.value });
            setToast({ type: "success", message: `تم تحديد المورد لـ ${items.length} منتج` });
            break;
          case "location":
            await bulkUpdateProducts(items, { type: "location", value: action.value });
            setToast({ type: "success", message: `تم تحديد المكان لـ ${items.length} منتج` });
            break;
          case "exportCsv": {
            const csv = productsToCsv(items);
            const date = new Date().toISOString().slice(0, 10);
            downloadCsv(`inventory-selected-${date}.csv`, csv);
            break;
          }
        }
      } catch (e: any) {
        setToast({ type: "error", message: e.message || "تعذر تنفيذ الإجراء" });
      }
    },
    [selectedIds, filteredProducts]
  );

  const handleBulkDeleteConfirm = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await bulkDeleteProducts(ids);
      setSelectedIds(new Set());
      setToast({ type: "success", message: `تم حذف ${ids.length} منتج` });
    } catch (e: any) {
      setToast({ type: "error", message: e.message || "تعذر الحذف الجماعي" });
    } finally {
      setBulkConfirm(null);
    }
  }, [selectedIds]);

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
    return (
      <AppShell title="المخزن">
        <div className="flex items-center justify-center py-20">
          <LoadingSpinner />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="المخزن">
      <div className="space-y-4">
        {/* Summary cards */}
        <InventorySummary
          products={products}
          onFilterLow={() => setSelectedStockStatus("low")}
          onFilterOut={() => setSelectedStockStatus("out")}
        />

        {/* Search */}
        <input
          type="text"
          placeholder="ابحث بالاسم، الباركود، التاج، البراند، أو المورد..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          dir="rtl"
          className="w-full px-4 py-3 rounded-xl border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent"
        />

        {/* Filters */}
        <InventoryFilters
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
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

        {/* Sort + tools */}
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
              title="منتجات لم تُبَع في 60 يوم"
            >
              <Skull className="w-4 h-4" />
              مخزون راكد
            </button>
            {hasAnyFilter && (
              <button
                onClick={handleResetFilters}
                className="px-3 py-2 rounded-lg text-sm text-text-secondary hover:text-accent border border-border bg-white"
              >
                مسح الفلاتر
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                setDensity(density === "compact" ? "comfortable" : "compact")
              }
              className="hidden md:flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-border bg-white text-text-secondary hover:border-accent"
              title="كثافة الجدول"
            >
              {density === "compact" ? (
                <Rows3 className="w-4 h-4" />
              ) : (
                <LayoutGrid className="w-4 h-4" />
              )}
              {density === "compact" ? "موسّع" : "مدمج"}
            </button>
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-border bg-white text-text-secondary hover:border-accent"
            >
              <Upload className="w-4 h-4" />
              استيراد
            </button>
            <button
              onClick={handleExportCsv}
              disabled={filteredProducts.length === 0}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-border bg-white text-text-secondary hover:border-accent disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              تصدير CSV
            </button>
          </div>
        </div>

        {/* Bulk actions */}
        <BulkActionsBar
          selected={selectedProducts}
          onClear={() => setSelectedIds(new Set())}
          onAction={handleBulkAction}
        />

        {/* Product Count */}
        <p className="text-sm text-text-secondary">
          {filteredProducts.length} منتج في المخزن
        </p>

        {/* Empty State */}
        {filteredProducts.length === 0 && (
          <EmptyState
            type="products"
            message={
              query
                ? `لا توجد نتائج للبحث عن "${query}"`
                : hasAnyFilter
                  ? "لا توجد نتائج تطابق الفلاتر الحالية"
                  : "لم تتم إضافة أي أصناف بعد. ابدأ بإضافة صنف جديد."
            }
          />
        )}

        {/* Desktop Table */}
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

        {/* Mobile Cards */}
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

      {/* Edit Modal */}
      <EditProductModal
        isOpen={!!editProduct}
        onClose={() => setEditProduct(null)}
        product={editProduct}
        onSuccess={() => setToast({ type: "success", message: "تم تحديث المنتج بنجاح" })}
      />

      {/* History Modal */}
      <ProductHistoryModal
        isOpen={!!historyProduct}
        onClose={() => setHistoryProduct(null)}
        product={historyProduct}
      />

      {/* CSV Import */}
      <CsvImportModal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        onSuccess={(count) =>
          setToast({ type: "success", message: `تم استيراد ${count} منتج` })
        }
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={!!deleteProductData}
        onClose={() => setDeleteProductData(null)}
        onConfirm={handleDelete}
        title="حذف المنتج"
        message={`هل أنت متأكد من حذف "${deleteProductData?.name}"؟`}
        confirmText="حذف"
        variant="danger"
      />

      {/* Bulk Delete Confirmation */}
      <ConfirmDialog
        isOpen={!!bulkConfirm}
        onClose={() => setBulkConfirm(null)}
        onConfirm={handleBulkDeleteConfirm}
        title="حذف جماعي"
        message={`هل أنت متأكد من حذف ${bulkConfirm?.count || 0} منتج؟ لا يمكن التراجع.`}
        confirmText="حذف الكل"
        variant="danger"
      />

      {/* Toast */}
      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </AppShell>
  );
}
