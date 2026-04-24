"use client";

import { useState, useMemo } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useProducts } from "@/hooks/useProducts";
import { useSearch } from "@/hooks/useSearch";
import { InventoryFilters } from "@/components/inventory/InventoryFilters";
import { ProductTable } from "@/components/inventory/ProductTable";
import { ProductCard } from "@/components/inventory/ProductCard";
import { EditProductModal } from "@/components/inventory/EditProductModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Toast } from "@/components/ui/Toast";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { deleteProduct } from "@/lib/firestore";
import type { Product, Category, Gender } from "@/lib/types";

export default function InventoryPage() {
  const { products, loading } = useProducts();
  const { query, setQuery, filtered } = useSearch(products, ["name", "brand", "category"]);

  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [selectedGender, setSelectedGender] = useState<Gender | null>(null);
  const [selectedBrand, setSelectedBrand] = useState<string | null>(null);

  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [deleteProductData, setDeleteProductData] = useState<Product | null>(null);
  const [sellProduct, setSellProduct] = useState<Product | null>(null);

  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const filteredProducts = useMemo(() => {
    return filtered.filter((p) => {
      if (selectedCategory && p.category !== selectedCategory) return false;
      if (selectedGender && p.gender !== selectedGender) return false;
      if (selectedBrand && p.brand !== selectedBrand) return false;
      return true;
    });
  }, [filtered, selectedCategory, selectedGender, selectedBrand]);

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
                : "لم تتم إضافة أي أصناف بعد. ابدأ بإضافة صنف جديد."
            }
          />
        )}

        {/* Desktop Table */}
        <div className="hidden md:block">
          <ProductTable
            products={filteredProducts}
            onEdit={setEditProduct}
            onDelete={setDeleteProductData}
            onSell={handleSell}
          />
        </div>

        {/* Mobile Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:hidden">
          {filteredProducts.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onEdit={setEditProduct}
              onDelete={setDeleteProductData}
              onSell={handleSell}
            />
          ))}
        </div>
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