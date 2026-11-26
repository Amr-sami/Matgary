import { cn } from "@/lib/utils";

// Known variants get curated colors; anything else falls back to "other".
type BadgeVariant =
  | "watches"
  | "perfumes"
  | "sunglasses"
  | "male"
  | "female"
  | "sold"
  | "returned"
  | "lowstock"
  | "outofstock"
  | "other";

interface BadgeProps {
  variant?: BadgeVariant | string;
  children: React.ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  watches: "bg-blue-100 text-blue-700",
  perfumes: "bg-purple-100 text-purple-700",
  sunglasses: "bg-teal-100 text-teal-700",
  male: "bg-blue-100 text-blue-700",
  female: "bg-pink-100 text-pink-700",
  sold: "bg-success-light text-success",
  returned: "bg-danger-light text-danger",
  lowstock: "bg-orange-100 text-orange-700",
  outofstock: "bg-danger-light text-danger",
  other: "bg-gray-100 text-gray-700",
};

const variantLabels: Record<BadgeVariant, string> = {
  watches: "ساعات",
  perfumes: "برفانات",
  sunglasses: "نظارات",
  male: "رجالي",
  female: "حريمي",
  sold: "مباع",
  returned: "مرتجع",
  lowstock: "كمية منخفضة",
  outofstock: "نفذ",
  other: "أخرى",
};

function resolveVariant(v: BadgeVariant | string | undefined): BadgeVariant {
  if (v && v in variantStyles) return v as BadgeVariant;
  return "other";
}

export function Badge({ variant, children, className }: BadgeProps) {
  const v = resolveVariant(variant);
  const label = children || variantLabels[v];
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium",
        variantStyles[v],
        className,
      )}
    >
      {label}
    </span>
  );
}
