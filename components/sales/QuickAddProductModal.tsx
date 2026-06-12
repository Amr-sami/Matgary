"use client";

// Inline product creation from the sales page. Lets a cashier add an
// item they're holding in their hand to the catalog WITHOUT leaving the
// register: pick a category, type a name + price, save. The new product
// joins the catalog like any other — appears in /inventory, can be edited,
// can be searched and sold again later.
//
// Only the minimum fields are exposed. Anything else (brand, low-stock
// threshold, SKU, supplier, attributes) is set to sensible defaults; the
// cashier can refine it later from /inventory if they care to.

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SortSelect } from "../ui/FilterSelect";
import { createProduct } from "@/lib/api/products";
import { useCategories } from "@/hooks/useCategories";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export interface QuickAddProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-fill the name from whatever the cashier typed in search. */
  initialName?: string;
  /** Called with the freshly-created product id so the caller can refresh
   *  its product list AND select the new item. */
  onCreated: (productId: string) => void | Promise<void>;
}

export function QuickAddProductModal({
  isOpen,
  onClose,
  initialName = "",
  onCreated,
}: QuickAddProductModalProps) {
  const dict = useDictionary();
  const t = dict.app.sales.form.quickAddProduct;
  const { data: categories } = useCategories();

  const [name, setName] = useState(initialName);
  const [categoryId, setCategoryId] = useState<string>("");
  const [price, setPrice] = useState<number>(0);
  const [costPrice, setCostPrice] = useState<number | "">("");
  const [quantity, setQuantity] = useState<number>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the modal re-opens with a new search seed.
  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setPrice(0);
      setCostPrice("");
      setQuantity(1);
      setError(null);
    }
  }, [isOpen, initialName]);

  // Default-select the first category once they load.
  useEffect(() => {
    if (!categoryId && categories.length > 0) {
      setCategoryId(categories[0]!.id);
    }
  }, [categories, categoryId]);

  const canSave =
    !loading &&
    name.trim().length > 0 &&
    categoryId.length > 0 &&
    price >= 0 &&
    quantity >= 0;

  const handleSave = async () => {
    setError(null);
    setLoading(true);
    try {
      const { id } = await createProduct({
        name: name.trim(),
        categoryId,
        price: Number(price),
        quantity: Number(quantity),
        costPrice: costPrice === "" ? undefined : Number(costPrice),
      });
      // Await the caller's refresh + select so the parent dropdown
      // re-fetches BEFORE the modal closes — no flash of stale data,
      // and the newly created product is auto-selected for the sale.
      await onCreated(id);
      onClose();
    } catch (e: any) {
      setError(e?.message || t.errorGeneric);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.title}>
      <div className="space-y-4">
        <Input
          label={t.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.namePlaceholder}
          dir="auto"
          autoFocus
        />

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t.category}
          </label>
          <SortSelect
            value={categoryId}
            onChange={setCategoryId}
            options={categories.map((c) => ({ value: c.id, label: c.label }))}
            fullWidth
            ariaLabel={t.category}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label={t.price}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(Number(e.target.value))}
          />
          <Input
            label={t.quantity}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </div>

        <Input
          label={t.costPrice}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={costPrice}
          onChange={(e) => {
            const v = e.target.value;
            setCostPrice(v === "" ? "" : Number(v));
          }}
          placeholder={t.costPricePlaceholder}
        />

        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            {dict.app.common.cancel}
          </Button>
          <Button
            onClick={handleSave}
            loading={loading}
            disabled={!canSave}
            className="flex-1"
          >
            {t.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
