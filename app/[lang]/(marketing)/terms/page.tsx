import type { Metadata } from "next";
import { TermsContent } from "./TermsContent";
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
    title: dict.marketing.terms.meta.title,
    description: dict.marketing.terms.meta.description,
  };
}

export default function TermsPage() {
  return <TermsContent />;
}
