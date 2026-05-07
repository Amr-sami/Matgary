import { Package, ShoppingCart, RotateCcw } from "@/lib/icons";

interface EmptyStateProps {
  type: "products" | "sales" | "returns";
  message?: string;
}

const messages = {
  products: {
    default: "لم تتم إضافة أي أصناف بعد. ابدأ بإضافة صنف جديد.",
    icon: Package,
  },
  sales: {
    default: "لم يتم تسجيل أي مبيعات بعد.",
    icon: ShoppingCart,
  },
  returns: {
    default: "لم تتم أي مرتجعات بعد.",
    icon: RotateCcw,
  },
};

export function EmptyState({ type, message }: EmptyStateProps) {
  const config = messages[type];
  const Icon = config.icon;

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon className="w-9 h-9 mb-4 text-text-secondary" />
      <p className="text-text-secondary max-w-sm">
        {message || config.default}
      </p>
    </div>
  );
}