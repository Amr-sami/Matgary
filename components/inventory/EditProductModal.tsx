"use client";

import { useState, useEffect } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SupplierPicker } from "../suppliers/SupplierPicker";
import { SortSelect } from "../ui/FilterSelect";
import { updateProduct } from "@/lib/api/products";
import { useCategories } from "@/hooks/useCategories";
import type { Product } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface EditProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: Product | null;
  onSuccess: () => void;
}

export function EditProductModal({
  isOpen,
  onClose,
  product,
  onSuccess,
}: EditProductModalProps) {
  const dict = useDictionary();
  const t = dict.app.inventory.editForm;
  const { data: categories } = useCategories();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [price, setPrice] = useState(0);
  const [costPrice, setCostPrice] = useState(0);
  const [lowStockThreshold, setLowStockThreshold] = useState(3);
  const [sku, setSku] = useState("");
  const [tags, setTags] = useState("");
  const [supplier, setSupplier] = useState("");
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [location, setLocation] = useState("");
  // categoryId is intentionally separate from `product` because we want
  // to let the owner re-categorise; the parent passes the current value
  // via `product.category` (the FK).
  const [categoryId, setCategoryId] = useState<string>("");

  useEffect(() => {
    if (product && isOpen) {
      setName(product.name);
      setBrand(product.brand || "");
      setQuantity(product.quantity);
      setPrice(product.price);
      setCostPrice(product.costPrice || 0);
      setLowStockThreshold(product.lowStockThreshold || 3);
      setSku(product.sku || "");
      setTags((product.tags || []).join(", "));
      setSupplier(product.supplier || "");
      setSupplierId(product.supplierId ?? null);
      setLocation(product.location || "");
      setCategoryId(product.category);
    }
  }, [product, isOpen]);

  const handleSave = async () => {
    if (!product) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      alert(t.errors.nameRequired);
      return;
    }
    setLoading(true);
    try {
      const tagList = tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      await updateProduct(product.id, {
        name: trimmedName,
        brand: brand.trim(),
        quantity: Number(quantity),
        price: Number(price),
        costPrice: Number(costPrice),
        lowStockThreshold: Number(lowStockThreshold),
        sku: sku.trim(),
        // When a supplier is linked, clear the legacy free-text field so it
        // doesn't shadow the FK on next read.
        supplier: supplierId ? "" : supplier.trim(),
        supplierId,
        location: location.trim(),
        tags: tagList,
        // Only send categoryId when it differs from the current value —
        // skips an unnecessary catalog cache bust on every save.
        ...(categoryId && categoryId !== product.category
          ? { categoryId }
          : {}),
      });
      onSuccess();
      onClose();
    } catch (error) {
      console.error(error);
      alert(t.errors.updateFailed);
    } finally {
      setLoading(false);
    }
  };

  if (!product) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.title}>
      <div className="space-y-4">
        <Input
          label={t.fields.name}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Input
          label={t.fields.brand}
          type="text"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
        />

        {/* Category picker — added in the inventory-edit UX pass so the
            owner can re-categorise a product without going back to the
            full /add-product wizard. */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t.fields.category}
          </label>
          <SortSelect
            value={categoryId}
            onChange={setCategoryId}
            options={categories.map((c) => ({ value: c.id, label: c.label }))}
            fullWidth
            ariaLabel={t.fields.category}
          />
        </div>

        <Input
          label={t.fields.quantity}
          type="number"
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
          min={0}
        />

        <Input
          label={t.fields.price}
          type="number"
          value={price}
          onChange={(e) => setPrice(Number(e.target.value))}
          min={0}
        />

        <Input
          label={t.fields.costPrice}
          type="number"
          value={costPrice}
          onChange={(e) => setCostPrice(Number(e.target.value))}
          min={0}
        />

        <Input
          label={t.fields.lowStockThreshold}
          type="number"
          value={lowStockThreshold}
          onChange={(e) => setLowStockThreshold(Number(e.target.value))}
          min={1}
        />

        <Input
          label={t.fields.sku}
          type="text"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
        />

        <SupplierPicker
          value={supplierId}
          onChange={setSupplierId}
          label={t.fields.supplier}
        />
        {!supplierId && supplier && (
          <Input
            label={t.fields.legacySupplier}
            type="text"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          />
        )}

        <Input
          label={t.fields.location}
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />

        <Input
          label={t.fields.tags}
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t.fields.tagsPlaceholder}
        />

        <div className="flex gap-3 pt-4">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            {dict.app.common.cancel}
          </Button>
          <Button onClick={handleSave} loading={loading} className="flex-1">
            {t.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
