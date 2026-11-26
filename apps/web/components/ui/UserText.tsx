import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Render user-entered text (product name, customer name, branch name,
 * receipt block, note) with `dir="auto"` so the browser picks the script
 * direction per string. Critical for mixed-locale UIs: an English product
 * name embedded in an Arabic page should still read left-to-right.
 *
 * Default tag is <span>. Pass `as="div"` (or any other valid block element)
 * for block-level usage. The dir attribute is the whole point — never
 * override it.
 */
interface UserTextProps {
  children: ReactNode;
  className?: string;
  as?: "span" | "div" | "p" | "h1" | "h2" | "h3" | "h4";
}

export function UserText({
  children,
  className,
  as: Tag = "span",
}: UserTextProps) {
  return (
    <Tag dir="auto" className={cn(className)}>
      {children}
    </Tag>
  );
}
