"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "@/lib/icons";
import { Button } from "../ui/Button";
import { useCategories } from "@/hooks/useCategories";
import type { BrandDescriptor } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

type Toast = { type: "success" | "error"; message: string };

interface Props {
  onToast: (t: Toast) => void;
}

export function BrandsEditor({ onToast }: Props) {
  const dict = useDictionary();
  const t = dict.app.catalog.brandsAdmin;
  const { data: categories } = useCategories();
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [brands, setBrands] = useState<BrandDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (!selectedCategoryId && categories.length > 0) {
      setSelectedCategoryId(categories[0].id);
    }
  }, [categories, selectedCategoryId]);

  const refresh = async (cid: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/brands?categoryId=${cid}`, { cache: "no-store" });
      const json: { data: BrandDescriptor[] } = await res.json();
      setBrands(json.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedCategoryId) refresh(selectedCategoryId);
  }, [selectedCategoryId]);

  const addBrand = async () => {
    const name = newName.trim();
    if (!name || !selectedCategoryId) return;
    const res = await fetch("/api/brands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, categoryId: selectedCategoryId }),
    });
    if (!res.ok) {
      onToast({
        type: "error",
        message: (await res.json().catch(() => ({}))).error || t.errors.addFailed,
      });
      return;
    }
    setNewName("");
    await refresh(selectedCategoryId);
  };

  const removeBrand = async (id: string) => {
    if (!confirm(t.confirmDelete)) return;
    await fetch(`/api/brands/${id}`, { method: "DELETE" });
    if (selectedCategoryId) await refresh(selectedCategoryId);
  };

  if (categories.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-border p-6">
        <h2 className="text-lg font-bold text-text-primary mb-2">{t.title}</h2>
        <p className="text-sm text-text-secondary">
          {t.noCategoriesHint}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
      <h2 className="text-lg font-bold text-text-primary">{t.title}</h2>

      <div className="flex flex-wrap gap-2">
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelectedCategoryId(c.id)}
            className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
              selectedCategoryId === c.id
                ? "bg-accent text-white border-accent"
                : "bg-white border-border text-text-secondary hover:border-accent"
            }`}
            dir="auto"
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          dir="auto"
          placeholder={t.newPlaceholder}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="flex-1 px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <Button onClick={addBrand} disabled={!newName.trim() || !selectedCategoryId}>
          <Plus className="w-4 h-4 me-1" />
          {t.add}
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">{t.loading}</p>
      ) : brands.length === 0 ? (
        <p className="text-sm text-text-secondary">{t.empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {brands.map((b) => (
            <li key={b.id} className="flex items-center justify-between py-2">
              <span className="text-sm" dir="auto">{b.name}</span>
              <button
                type="button"
                onClick={() => removeBrand(b.id)}
                className="p-1.5 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger"
                title={t.deleteTitle}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
