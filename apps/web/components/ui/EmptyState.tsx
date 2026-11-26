"use client";

import { Package, ShoppingCart, RotateCcw } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

type EmptyType = "products" | "sales" | "returns";

interface EmptyStateProps {
  type: EmptyType;
  message?: string;
}

const ICONS = {
  products: Package,
  sales: ShoppingCart,
  returns: RotateCcw,
} as const;

export function EmptyState({ type, message }: EmptyStateProps) {
  const dict = useDictionary();
  const Icon = ICONS[type];
  const defaultMessage = dict.app.ui.empty[type];

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon className="w-9 h-9 mb-4 text-text-secondary" />
      <p className="text-text-secondary max-w-sm">
        {message || defaultMessage}
      </p>
    </div>
  );
}
