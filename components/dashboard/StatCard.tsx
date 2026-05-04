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

const colorStyles = {
  accent: "bg-accent-light text-accent",
  success: "bg-success-light text-success",
  danger: "bg-danger-light text-danger",
};

export function StatCard({ title, value, subtitle, icon: Icon, color = "accent", href }: StatCardProps) {
  const content = (
    <div className={cn(
      "bg-white rounded-xl p-5 shadow-sm border border-border h-full transition-all duration-200",
      href && "hover:shadow-md hover:border-accent group"
    )}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-text-secondary group-hover:text-accent transition-colors">{title}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
          {subtitle && (
            <p className="text-xs text-text-secondary mt-1">{subtitle}</p>
          )}
        </div>
        <div className={cn(
          "p-3 rounded-lg transition-transform duration-200",
          colorStyles[color],
          href && "group-hover:scale-110"
        )}>
          <Icon className="w-5 h-5" />
        </div>
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