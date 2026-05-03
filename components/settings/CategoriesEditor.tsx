"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Save, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useCategories } from "@/hooks/useCategories";
import { slugify } from "@/lib/utils/slug";
import type { CategoryAttribute, CategoryDescriptor } from "@/lib/types";

// Curated icon options the picker shows. Anything else is allowed if typed
// into the icon field directly — Step1Category falls back to Package if it
// doesn't recognize a name.
const ICON_OPTIONS = [
  "Watch",
  "FlaskConical",
  "Glasses",
  "Headphones",
  "Shirt",
  "ShoppingBag",
  "Smartphone",
  "Pill",
  "Coffee",
  "Cookie",
  "Package",
];

type Toast = { type: "success" | "error"; message: string };

interface Props {
  onToast: (t: Toast) => void;
}

export function CategoriesEditor({ onToast }: Props) {
  const { data: categories, refresh } = useCategories();
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newIcon, setNewIcon] = useState("Package");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const addCategory = async () => {
    const label = newLabel.trim();
    if (!label) return;
    const key = slugify(label);
    setBusyId("__add");
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, label, icon: newIcon, position: categories.length }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      onToast({ type: "success", message: "تم إضافة القسم" });
      setNewLabel("");
      setNewIcon("Package");
      setAdding(false);
      await refresh();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : "تعذر الإضافة" });
    } finally {
      setBusyId(null);
    }
  };

  const removeCategory = async (id: string) => {
    if (!confirm("حذف هذا القسم؟")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/categories/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      onToast({ type: "success", message: "تم الحذف" });
      await refresh();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : "تعذر الحذف" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-border p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text-primary">الأقسام</h2>
        <Button
          variant={adding ? "ghost" : "secondary"}
          size="sm"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="w-4 h-4 me-1" />
          {adding ? "إلغاء" : "قسم جديد"}
        </Button>
      </div>

      {adding && (
        <div className="rounded-xl border border-border p-4 space-y-3 bg-bg-main/40">
          <Input
            label="اسم القسم"
            placeholder="مثال: سماعات"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              الأيقونة
            </label>
            <div className="flex flex-wrap gap-2">
              {ICON_OPTIONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setNewIcon(name)}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                    newIcon === name
                      ? "bg-accent text-white border-accent"
                      : "bg-white border-border text-text-secondary hover:border-accent"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          <Button onClick={addCategory} loading={busyId === "__add"} disabled={!newLabel.trim()}>
            <Save className="w-4 h-4 me-1" />
            حفظ
          </Button>
        </div>
      )}

      {categories.length === 0 ? (
        <p className="text-center text-text-secondary text-sm py-4">
          لا توجد أقسام بعد. أضف أول قسم من الزر أعلاه.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {categories.map((cat) => (
            <CategoryRow
              key={cat.id}
              category={cat}
              expanded={expandedId === cat.id}
              busy={busyId === cat.id}
              onToggle={() => setExpandedId((id) => (id === cat.id ? null : cat.id))}
              onDelete={() => removeCategory(cat.id)}
              onToast={onToast}
              onChange={refresh}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface RowProps {
  category: CategoryDescriptor;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onToast: (t: Toast) => void;
  onChange: () => Promise<void> | void;
}

function CategoryRow({ category, expanded, busy, onToggle, onDelete, onToast, onChange }: RowProps) {
  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 text-start flex-1 min-w-0"
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-text-secondary" />
          ) : (
            <ChevronRight className="w-4 h-4 text-text-secondary" />
          )}
          <span className="font-medium">{category.label}</span>
          <span className="text-xs text-text-secondary font-mono">{category.key}</span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="p-1.5 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger disabled:opacity-50"
          title="حذف"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {expanded && (
        <div className="mt-3 ms-6">
          <AttributesEditor categoryId={category.id} onToast={onToast} onChange={onChange} />
        </div>
      )}
    </li>
  );
}

interface AttrProps {
  categoryId: string;
  onToast: (t: Toast) => void;
  onChange: () => Promise<void> | void;
}

function AttributesEditor({ categoryId, onToast, onChange }: AttrProps) {
  const [attrs, setAttrs] = useState<CategoryAttribute[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/categories/${categoryId}/attributes`, { cache: "no-store" });
      const json: { data: CategoryAttribute[] } = await res.json();
      setAttrs(json.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

  const addAttr = async () => {
    const label = newLabel.trim();
    if (!label) return;
    const key = slugify(label);
    try {
      const res = await fetch(`/api/categories/${categoryId}/attributes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, label, position: attrs.length }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setNewLabel("");
      setAdding(false);
      await refresh();
      await onChange();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : "تعذر الإضافة" });
    }
  };

  const removeAttr = async (id: string) => {
    if (!confirm("حذف هذه الخاصية؟")) return;
    await fetch(`/api/attributes/${id}`, { method: "DELETE" });
    await refresh();
    await onChange();
  };

  const addValue = async (attrId: string, label: string) => {
    const t = label.trim();
    if (!t) return;
    const key = slugify(t);
    const res = await fetch(`/api/attributes/${attrId}/values`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, label: t, position: 0 }),
    });
    if (!res.ok) {
      onToast({ type: "error", message: (await res.json().catch(() => ({}))).error || "تعذر الإضافة" });
      return;
    }
    await refresh();
  };

  const removeValue = async (id: string) => {
    if (!confirm("حذف هذه القيمة؟")) return;
    await fetch(`/api/attribute-values/${id}`, { method: "DELETE" });
    await refresh();
  };

  if (loading) return <div className="text-sm text-text-secondary">جاري التحميل…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-secondary">الخصائص</h3>
        <Button variant="ghost" size="sm" onClick={() => setAdding((v) => !v)}>
          <Plus className="w-3.5 h-3.5 me-1" />
          {adding ? "إلغاء" : "خاصية"}
        </Button>
      </div>

      {adding && (
        <div className="flex gap-2">
          <Input
            placeholder="اسم الخاصية (مثل: النوع)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <Button size="sm" onClick={addAttr} disabled={!newLabel.trim()}>
            حفظ
          </Button>
        </div>
      )}

      {attrs.length === 0 ? (
        <p className="text-xs text-text-secondary">
          لا توجد خصائص. تخطّى المعالج الخطوة الثانية لهذا القسم.
        </p>
      ) : (
        <ul className="space-y-3">
          {attrs.map((a) => (
            <AttributeRow key={a.id} attr={a} onAddValue={addValue} onRemove={removeAttr} onRemoveValue={removeValue} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttributeRow({
  attr,
  onAddValue,
  onRemove,
  onRemoveValue,
}: {
  attr: CategoryAttribute;
  onAddValue: (attrId: string, label: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRemoveValue: (id: string) => Promise<void>;
}) {
  const [val, setVal] = useState("");
  return (
    <li className="rounded-lg border border-border p-3 space-y-2 bg-bg-main/30">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-sm">{attr.label}</div>
          <div className="text-xs text-text-secondary font-mono">{attr.key}</div>
        </div>
        <button
          type="button"
          onClick={() => onRemove(attr.id)}
          className="p-1.5 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {attr.values.map((v) => (
          <span
            key={v.id}
            className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-accent-light text-accent"
          >
            {v.label}
            <button
              type="button"
              onClick={() => onRemoveValue(v.id)}
              className="text-accent/60 hover:text-danger"
              title="حذف"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          dir="rtl"
          placeholder="قيمة جديدة (مثل: رجالي)"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="flex-1 px-3 py-1.5 rounded-md border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await onAddValue(attr.id, val);
            setVal("");
          }}
          disabled={!val.trim()}
        >
          إضافة
        </Button>
      </div>
    </li>
  );
}
