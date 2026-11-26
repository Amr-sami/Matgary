import { LucideIcon } from "@/lib/icons";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  color?: "accent" | "success" | "danger";
  href?: string;
}

// Color → text-only token. Background "chips" were dropped per design — the
// icon now shows in the brand colour without the filled rounded square.
const colorStyles = {
  accent: "text-accent",
  success: "text-success",
  danger: "text-danger",
};

export function StatCard({ title, value, subtitle, icon: Icon, color = "accent", href }: StatCardProps) {
  const content = (
    <div className={cn(
      // p-4 on phones: at p-5 the two-up grid leaves the value only ~105px,
      // and "277,575 ج.م" needs 128px at text-2xl — the number was breaking
      // away from its currency. Measured, not guessed.
      "bg-white rounded-xl p-4 lg:p-5 shadow-sm border border-border h-full transition-all duration-200",
      href && "hover:shadow-md hover:border-accent group"
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-text-secondary group-hover:text-accent transition-colors">{title}</p>
          {/* A money figure must never split from its currency. text-xl on
              phones keeps six-figure EGP on one line; lg restores the
              desktop size, where there is room to spare. */}
          <p className="text-xl lg:text-2xl font-bold mt-1 whitespace-nowrap tabular-nums">{value}</p>
          {subtitle && (
            <p className="text-xs text-text-secondary mt-1">{subtitle}</p>
          )}
        </div>
        <Icon
          className={cn(
            "w-6 h-6 transition-transform duration-200",
            colorStyles[color],
            href && "group-hover:scale-110",
          )}
        />
      </div>
    </div>
  );

  if (href) {
    return (
      <Link href={href}>
        {content}
      </Link>
    );
  }

  return content;
}