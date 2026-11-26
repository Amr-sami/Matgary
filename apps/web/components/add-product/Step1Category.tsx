"use client";

import { useState } from "react";
import * as Icons from "@/lib/icons";
import { Package, Plus } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { slugify } from "@/lib/utils/slug";
import type { CategoryDescriptor } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

const DEFAULT_NEW_CATEGORY_ICON = "Package";

interface Step1CategoryProps {
  categories: CategoryDescriptor[];
  selectedId: string | null;
  onSelect: (categoryId: string) => void;
  onCategoryCreated?: (newCategoryId: string | null) => Promise<void> | void;
  loading?: boolean;
}

// Resolve a stored icon name (e.g. "Watch") to a lucide component, falling
// back to Package if the tenant chose a name we don't ship. The fallback
// keeps the wizard usable for tenants that pick custom icons we haven't
// curated yet.
function getIcon(name: string | null) {
  if (!name) return Package;
  const lib = Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>;
  return lib[name] ?? Package;
}

export function Step1Category({
  categories,
  selectedId,
  onSelect,
  onCategoryCreated,
  loading,
}: Step1CategoryProps) {
  const dict = useDictionary();
  const t = dict.app.inventory.addProduct.step1;
  const [modalOpen, setModalOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeModal = () => {
    setModalOpen(false);
    setNewLabel("");
    setError(null);
  };

  const submitNewCategory = async () => {
    const label = newLabel.trim();
    if (!label) return;
    setSaving(true);
    setError(null);
    try {
      const key = slugify(label);
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          label,
          icon: DEFAULT_NEW_CATEGORY_ICON,
          position: categories.length,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      const newId: string | null = json?.id ?? null;
      await onCategoryCreated?.(newId);
      if (newId) onSelect(newId);
      closeModal();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.newCategory.error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12 text-text-secondary">{t.loading}</div>
    );
  }

  return (
    <div>
      <h3 className="text-center font-semibold mb-6">{t.heading}</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {categories.map((cat) => {
          const Icon = getIcon(cat.icon);
          const isSelected = selectedId === cat.id;

          return (
            <button
              key={cat.id}
              onClick={() => onSelect(cat.id)}
              className={cn(
                "flex flex-col items-center justify-center p-8 rounded-xl border-2 transition-all",
                isSelected
                  ? "border-accent bg-accent-light text-accent"
                  : "border-border bg-white hover:border-accent/50",
              )}
            >
              <Icon className={cn("w-16 h-16 mb-4", isSelected && "text-accent")} />
              <span className="text-xl font-semibold" dir="auto">{cat.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="flex flex-col items-center justify-center p-8 rounded-xl border-2 border-dashed border-border bg-white text-text-secondary hover:border-accent hover:text-accent transition-all"
        >
          <Plus className="w-16 h-16 mb-4" />
          <span className="text-xl font-semibold">{t.addCategory}</span>
        </button>
      </div>

      <Modal isOpen={modalOpen} onClose={closeModal} title={t.newCategory.title}>
        <div className="space-y-4">
          <Input
            label={t.newCategory.label}
            placeholder={t.newCategory.placeholder}
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            autoFocus
          />

          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={closeModal}
              disabled={saving}
              className="flex-1"
            >
              {dict.app.common.cancel}
            </Button>
            <Button
              onClick={submitNewCategory}
              loading={saving}
              disabled={!newLabel.trim()}
              className="flex-1"
            >
              {t.newCategory.save}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
