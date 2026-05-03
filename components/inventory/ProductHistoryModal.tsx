"use client";

import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { LoadingSpinner } from "../ui/LoadingSpinner";
import type { ProductHistoryEvent as _PHE } from "@/lib/types";
import type { Product, ProductHistoryEvent } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Pencil,
  PlusCircle,
  ShoppingCart,
  Undo2,
} from "lucide-react";

interface ProductHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: Product | null;
}

const EVENT_LABELS: Record<ProductHistoryEvent["type"], string> = {
  created: "تمت الإضافة",
  updated: "تعديل بيانات",
  restocked: "زيادة كمية",
  decreased: "إنقاص كمية",
  sold: "بيع",
  returned: "مرتجع",
};

function eventIcon(type: ProductHistoryEvent["type"]) {
  switch (type) {
    case "created":
      return <PlusCircle className="w-4 h-4 text-success" />;
    case "updated":
      return <Pencil className="w-4 h-4 text-accent" />;
    case "restocked":
      return <ArrowUpFromLine className="w-4 h-4 text-success" />;
    case "decreased":
      return <ArrowDownToLine className="w-4 h-4 text-orange-500" />;
    case "sold":
      return <ShoppingCart className="w-4 h-4 text-accent" />;
    case "returned":
      return <Undo2 className="w-4 h-4 text-text-secondary" />;
  }
}

export function ProductHistoryModal({ isOpen, onClose, product }: ProductHistoryModalProps) {
  const [events, setEvents] = useState<ProductHistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOpen || !product) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/products/${product.id}/history`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: { data: Array<Omit<ProductHistoryEvent, "createdAt"> & { createdAt: string }> } =
          await res.json();
        if (cancelled) return;
        setEvents(
          json.data.map((e) => ({ ...e, createdAt: new Date(e.createdAt) })),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, product]);

  if (!product) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`سجل: ${product.name}`}>
      <div className="space-y-3">
        {loading ? (
          <div className="py-8 flex justify-center">
            <LoadingSpinner />
          </div>
        ) : events.length === 0 ? (
          <p className="text-center text-text-secondary py-8">
            لا يوجد سجل سابق لهذا المنتج
          </p>
        ) : (
          <ul className="space-y-2">
            {events.map((e) => (
              <li
                key={e.id}
                className="flex items-start gap-3 p-3 rounded-lg border border-border bg-white"
              >
                <div className="mt-0.5">{eventIcon(e.type)}</div>
                <div className="flex-1">
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <span className="font-medium text-sm">{EVENT_LABELS[e.type]}</span>
                    <span className="text-xs text-text-secondary">
                      {formatDateTime(e.createdAt)}
                    </span>
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5">
                    {typeof e.delta === "number" && (
                      <span className={e.delta >= 0 ? "text-success" : "text-orange-600"}>
                        {e.delta >= 0 ? `+${e.delta}` : e.delta}
                      </span>
                    )}
                    {typeof e.quantityAfter === "number" && (
                      <span className="ms-2">→ الكمية: {e.quantityAfter}</span>
                    )}
                    {e.note && <span className="ms-2">— {e.note}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
