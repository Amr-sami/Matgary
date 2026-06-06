import type { Metadata } from "next";
import { HelpContent } from "./HelpContent";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return {
    title: dict.marketing.help.meta.title,
    description: dict.marketing.help.meta.description,
  };
}

export default function HelpPage() {
  return <HelpContent />;
}
