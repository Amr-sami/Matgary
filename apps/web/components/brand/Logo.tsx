import { cn } from "@/lib/utils";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  className?: string;
  /**
   * Selects the wordmark PNG per locale. Unknown values fall back to
   * the Arabic PNG since Arabic is the app default.
   */
  locale?: "ar" | "en" | string;
}

const LOGO_SRC: Record<"ar" | "en", { src: string; alt: string }> = {
  en: { src: "/thestorologoenglish.png", alt: "TheStoro" },
  ar: { src: "/storoarabic.png", alt: "ستورو" },
};

// PNG is 1080×1080 with the wordmark centered horizontally and a lot of
// vertical whitespace above/below. Using object-cover on a wide aspect
// container crops that whitespace and leaves just the wordmark visible.
const PNG_BOX: Record<NonNullable<LogoProps["size"]>, string> = {
  sm: "w-40 h-10",
  md: "w-40 h-10",
  lg: "w-56 h-14",
};

export function Logo({ size = "md", className, locale }: LogoProps) {
  const asset = locale === "en" ? LOGO_SRC.en : LOGO_SRC.ar;
  return (
    <span
      className={cn("inline-flex items-center justify-center select-none", className)}
      aria-label={asset.alt}
    >
      <img
        src={asset.src}
        alt={asset.alt}
        className={cn("object-cover", PNG_BOX[size])}
        draggable={false}
      />
    </span>
  );
}
