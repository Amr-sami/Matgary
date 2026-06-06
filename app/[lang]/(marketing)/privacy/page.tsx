import type { Metadata } from "next";
import { PrivacyContent } from "./PrivacyContent";
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
    title: dict.marketing.privacy.meta.title,
    description: dict.marketing.privacy.meta.description,
  };
}

export default function PrivacyPage() {
  return <PrivacyContent />;
}
