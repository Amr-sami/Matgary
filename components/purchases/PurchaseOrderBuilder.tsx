"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Search } from "@/lib/icons";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { SupplierPicker } from "@/components/suppliers/SupplierPicker";
import { useProducts } from "@/hooks/useProducts";
import type { Product } from "@/lib/types";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

interface Line {
  /** Stable client id for list keying. */
  uid: string;
  productId: string | null;
  productName: string;
  quantity: number;
  unitCost: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}

let nextUid = 1;
const newUid = () => `line-${nextUid++}`;

export function PurchaseOrderBuilder({ isOpen, onClose, onSaved, onError }: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.purchases.builder;
  const { products } = useProducts();
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [productQuery, setProductQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSupplierId(null);
    setNotes("");
    setLines([]);
    setProductQuery("");
  }, [isOpen]);

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0),
    [lines],
  );

  const matchingProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q) return [] as Product[];
    return products
      .filter((p) =>
        `${p.name} ${p.brand || ""} ${p.sku || ""}`.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [products, productQuery]);

  const addLine = (product: Product) => {
    // If already in list, just bump quantity.
    const existing = lines.find((l) => l.productId === product.id);
    if (existing) {
      setLines((curr) =>
        curr.map((l) =>
          l.uid === existing.uid ? { ...l, quantity: l.quantity + 1 } : l,
        ),
      );
    } else {
      setLines((curr) => [
        ...curr,
        {
          uid: newUid(),
          productId: product.id,
          productName: product.name,
          quantity: 1,
          unitCost: product.costPrice ?? 0,
        },
      ]);
    }
    setProductQuery("");
  };

  const addBlankLine = () => {
    setLines((curr) => [
      ...curr,
      { uid: newUid(), productId: null, productName: "", quantity: 1, unitCost: 0 },
    ]);
  };

  const updateLine = (uid: string, patch: Partial<Line>) => {
    setLines((curr) => curr.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  };

  const removeLine = (uid: string) => {
    setLines((curr) => curr.filter((l) => l.uid !== uid));
  };

  const submit = async () => {
    if (!supplierId) {
      onError(t.errors.pickSupplier);
      return;
    }
    const cleaned = lines
      .map((l) => ({
        ...l,
        productName: l.productName.trim(),
      }))
      .filter((l) => l.productName && l.quantity > 0);
    if (cleaned.length === 0) {
      onError(t.errors.needLine);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId,
          notes: notes.trim() || null,
          items: cleaned.map((l) => ({
            productId: l.productId,
            productName: l.productName,
            quantity: l.quantity,
            unitCost: l.unitCost,
          })),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onError(json.error || t.errors.saveFailed);
        return;
      }
      onSaved();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.title} className="max-w-2xl">
      <div className="space-y-4">
        <SupplierPicker value={supplierId} onChange={setSupplierId} label={t.supplierLabel} />

        {/* Product search */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t.productSearchLabel}
          </label>
          <div className="relative">
            <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 end-3 text-text-secondary" />
            <input
              type="search"
              dir="auto"
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              placeholder={t.productSearchPlaceholder}
              className="w-full ps-3 pe-9 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          {productQuery && matchingProducts.length > 0 && (
            <div className="mt-1 border border-border rounded-lg bg-white max-h-48 overflow-y-auto">
              {matchingProducts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addLine(p)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-start hover:bg-bg-main"
                >
                  <span className="truncate text-sm" dir="auto">
                    {p.name}
                    {p.brand ? ` — ${p.brand}` : ""}
                  </span>
                  <span className="text-xs text-text-secondary shrink-0">
                    {t.costPrefix}{" "}
                    {p.costPrice ? formatCurrency(p.costPrice, locale) : "—"}
                  </span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={addBlankLine}
            className="mt-2 text-sm text-accent inline-flex items-center gap-1 hover:underline"
          >
            <Plus className="w-4 h-4" />
            {t.addExternal}
          </button>
        </div>

        {/* Lines */}
        {lines.length > 0 && (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-main">
                <tr className="text-text-secondary">
                  <th className="text-start px-3 py-2 font-medium">{t.table.name}</th>
                  <th className="text-start px-3 py-2 font-medium w-20">{t.table.quantity}</th>
                  <th className="text-start px-3 py-2 font-medium w-24">{t.table.unitCost}</th>
                  <th className="text-start px-3 py-2 font-medium w-24">{t.table.total}</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.uid} className="border-t border-border">
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        dir="auto"
                        value={l.productName}
                        onChange={(e) => updateLine(l.uid, { productName: e.target.value })}
                        className="w-full px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={1}
                        value={l.quantity}
                        onChange={(e) =>
                          updateLine(l.uid, { quantity: Math.max(1, Number(e.target.value) || 0) })
                        }
                        className="w-full px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={l.unitCost}
                        onChange={(e) =>
                          updateLine(l.uid, { unitCost: Math.max(0, Number(e.target.value) || 0) })
                        }
                        className="w-full px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      {formatCurrency(l.quantity * l.unitCost, locale)}
                    </td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        onClick={() => removeLine(l.uid)}
                        className="p-1 rounded hover:bg-danger-light text-text-secondary hover:text-danger"
                        title={t.table.deleteTitle}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-bg-main">
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-text-secondary text-end font-medium">
                    {t.table.totalRow}
                  </td>
                  <td className="px-3 py-2 font-bold">{formatCurrency(total, locale)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t.notesLabel}
          </label>
          <textarea
            dir="auto"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
          />
        </div>

        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.cancel}
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || !supplierId || lines.length === 0}
          >
            {submitting ? t.saving : t.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
