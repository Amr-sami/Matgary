import { CaretLeft, CaretRight } from "phosphor-react-native";

import { useLocale } from "@/i18n";
import { colors } from "@/theme/tokens";

/**
 * Direction-aware chevrons.
 *
 * "Forward" (this row opens something) points in the reading direction:
 * left under Arabic, right under English. "Back" is the opposite. Hardcoding
 * CaretLeft for forward was correct for the Arabic-only build and wrong the
 * moment the language could change — so the glyph is chosen here, from the
 * live locale, and nowhere else.
 */
interface Props {
  size?: number;
  color?: string;
}

export function ChevronForward({ size = 16, color = colors.textSecondary }: Props) {
  const rtl = useLocale((s) => s.locale === "ar");
  return rtl ? <CaretLeft size={size} color={color} /> : <CaretRight size={size} color={color} />;
}

export function ChevronBack({ size = 16, color = colors.textSecondary }: Props) {
  const rtl = useLocale((s) => s.locale === "ar");
  return rtl ? <CaretRight size={size} color={color} /> : <CaretLeft size={size} color={color} />;
}
