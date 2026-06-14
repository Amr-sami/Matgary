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
//
// Duplicate-name guard: when the cashier types a name that matches an
// existing product (case-insensitive, trimmed), we surface a warning
// with a "Use existing" action. This prevents accidental duplicates
// like 4× "معجون اسنان". Cashier can still force "Save as new" — the
// guard is soft, not a hard constraint.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SortSelect } from "../ui/FilterSelect";
import { createProduct } from "@/lib/api/products";
import { useCategories } from "@/hooks/useCategories";
import { useProducts } from "@/hooks/useProducts";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export interface QuickAddProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-fill the name from whatever the cashier typed in search. */
  initialName?: string;
  /** Pre-fill the SKU/barcode (used by the scan-not-found flow). */
  initialSku?: string;
  /** Called with the freshly-created product id so the caller can refresh
   *  its product list AND select the new item. */
  onCreated: (productId: string) => void | Promise<void>;
  /** Called when the cashier hits the "Use existing" duplicate-name
   *  shortcut. The caller decides what "use" means: select for the cart
   *  (POS) or filter the inventory list (browse). Falls back to
   *  onCreated if omitted. */
  onSelectExisting?: (productId: string) => void | Promise<void>;
}

export function QuickAddProductModal({
  isOpen,
  onClose,
  initialName = "",
  initialSku = "",
  onCreated,
  onSelectExisting,
}: QuickAddProductModalProps) {
  const dict = useDictionary();
  const t = dict.app.sales.form.quickAddProduct;
  const { data: categories } = useCategories();
  const { products } = useProducts();

  const [name, setName] = useState(initialName);
  const [categoryId, setCategoryId] = useState<string>("");
  const [price, setPrice] = useState<number>(0);
  const [costPrice, setCostPrice] = useState<number | "">("");
  const [quantity, setQuantity] = useState<number>(1);
  // SKU is only surfaced when pre-seeded from a scan — keeps the cashier
  // shortcut single-purpose. Blank → undefined on save.
  const [sku, setSku] = useState(initialSku);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the cashier triggers "Save as new anyway" we lift the
  // duplicate-name guard for the next save attempt.
  const [overrideDuplicate, setOverrideDuplicate] = useState(false);

  // Reset whenever the modal re-opens with a new search seed.
  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setSku(initialSku);
      setPrice(0);
      setCostPrice("");
      setQuantity(1);
      setError(null);
      setOverrideDuplicate(false);
    }
  }, [isOpen, initialName, initialSku]);

  // Default-select the first category once they load.
  useEffect(() => {
    if (!categoryId && categories.length > 0) {
      setCategoryId(categories[0]!.id);
    }
  }, [categories, categoryId]);

  // Find a product with the same name (case-insensitive, trimmed).
  // null until the cashier has typed something meaningful.
  const duplicate = useMemo(() => {
    const target = name.trim().toLowerCase();
    if (target.length < 2) return null;
    return products.find((p) => p.name.trim().toLowerCase() === target) ?? null;
  }, [name, products]);

  const canSave =
    !loading &&
    name.trim().length > 0 &&
    categoryId.length > 0 &&
    price >= 0 &&
    quantity >= 0 &&
    (!duplicate || overrideDuplicate);

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
        sku: sku.trim() || undefined,
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

  const handleUseExisting = async () => {
    if (!duplicate) return;
    setLoading(true);
    try {
      const cb = onSelectExisting ?? onCreated;
      await cb(duplicate.id);
      onClose();
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
          onChange={(e) => {
            setName(e.target.value);
            // Re-arm the guard whenever the cashier edits the name.
            setOverrideDuplicate(false);
          }}
          placeholder={t.namePlaceholder}
          dir="auto"
          autoFocus
        />

        {duplicate && (
          <div className="rounded-lg border border-warning bg-warning-light/40 p-3 space-y-2">
            <p className="text-sm font-semibold text-text-primary" dir="auto">
              {t.duplicateWarning.replace("{name}", duplicate.name)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={handleUseExisting}
                disabled={loading}
                className="text-sm"
              >
                {t.useExisting}
              </Button>
              {!overrideDuplicate && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setOverrideDuplicate(true)}
                  disabled={loading}
                  className="text-sm"
                >
                  {t.saveAsNewAnyway}
                </Button>
              )}
            </div>
          </div>
        )}

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
