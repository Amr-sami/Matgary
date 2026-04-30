"use client";

import { useState, useMemo, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, LayoutGrid, Rows3 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { useProducts } from "@/hooks/useProducts";
import { useSearch } from "@/hooks/useSearch";
import { InventoryFilters, type StockStatus } from "@/components/inventory/InventoryFilters";
import { SortMenu, type SortKey } from "@/components/inventory/SortMenu";
import { InventorySummary } from "@/components/inventory/InventorySummary";
import { ProductTable } from "@/components/inventory/ProductTable";
import { ProductCard } from "@/components/inventory/ProductCard";
import { EditProductModal } from "@/components/inventory/EditProductModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Toast } from "@/components/ui/Toast";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { deleteProduct, adjustProductQuantity } from "@/lib/firestore";
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
  const { query, setQuery, filtered } = useSearch(products, ["name", "brand", "category"]);

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
  const [minPrice, setMinPrice] = useState(searchParams.get("min") || "");
  const [maxPrice, setMaxPrice] = useState(searchParams.get("max") || "");
  const [sortKey, setSortKey] = useState<SortKey>(
    (searchParams.get("sort") as SortKey) || "newest"
  );
  const [density, setDensity] = useState<"comfortable" | "compact">(
    (searchParams.get("d") as "comfortable" | "compact") || "comfortable"
  );

  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [deleteProductData, setDeleteProductData] = useState<Product | null>(null);
  const [_sellProduct, setSellProduct] = useState<Product | null>(null);

  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Persist filter state in URL
  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedCategory) params.set("cat", selectedCategory);
    if (selectedGender) params.set("gen", selectedGender);
    if (selectedBrand) params.set("brand", selectedBrand);
    if (selectedStockStatus) params.set("stock", selectedStockStatus);
    if (minPrice) params.set("min", minPrice);
    if (maxPrice) params.set("max", maxPrice);
    if (sortKey !== "newest") params.set("sort", sortKey);
    if (density !== "comfortable") params.set("d", density);
    const qs = params.toString();
    router.replace(qs ? `/inventory?${qs}` : "/inventory", { scroll: false });
  }, [
    selectedCategory,
    selectedGender,
    selectedBrand,
    selectedStockStatus,
    minPrice,
    maxPrice,
    sortKey,
    density,
    router,
  ]);

  // Build the dynamic brand list from real data
  const brands = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      if (p.brand && p.brand.trim()) set.add(p.brand.trim());
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
    selectedStockStatus,
    minPrice,
    maxPrice,
    sortKey,
  ]);

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

  const hasAnyFilter =
    !!selectedCategory ||
    !!selectedGender ||
    !!selectedBrand ||
    !!selectedStockStatus ||
    !!minPrice ||
    !!maxPrice ||
    !!query;

  const handleResetFilters = () => {
    setSelectedCategory(null);
    setSelectedGender(null);
    setSelectedBrand(null);
    setSelectedStockStatus(null);
    setMinPrice("");
    setMaxPrice("");
    setQuery("");
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
          placeholder="ابحث عن منتج، براند، أو صنف..."
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
        />

        {/* Sort + tools */}
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <SortMenu value={sortKey} onChange={setSortKey} />
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
              onClick={handleExportCsv}
              disabled={filteredProducts.length === 0}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-border bg-white text-text-secondary hover:border-accent disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              تصدير CSV
            </button>
          </div>
        </div>

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
              products={filteredProducts}
              onEdit={setEditProduct}
              onDelete={setDeleteProductData}
              onSell={handleSell}
              onAdjustQty={handleAdjustQty}
              density={density}
            />
          </div>
        )}

        {/* Mobile Cards */}
        {filteredProducts.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:hidden">
            {filteredProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onEdit={setEditProduct}
                onDelete={setDeleteProductData}
                onSell={handleSell}
                onAdjustQty={handleAdjustQty}
              />
            ))}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      <EditProductModal
        isOpen={!!editProduct}
        onClose={() => setEditProduct(null)}
        product={editProduct}
        onSuccess={() => setToast({ type: "success", message: "تم تحديث المنتج بنجاح" })}
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
