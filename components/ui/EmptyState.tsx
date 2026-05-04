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
      <div className="w-16 h-16 mb-4 rounded-full bg-gray-100 flex items-center justify-center">
        <Icon className="w-8 h-8 text-text-secondary" />
      </div>
      <p className="text-text-secondary max-w-sm">
        {message || config.default}
      </p>
    </div>
  );
}