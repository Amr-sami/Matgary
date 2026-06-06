import type { Metadata } from "next";
import { ContactContent } from "./ContactContent";
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
    title: dict.marketing.contact.meta.title,
    description: dict.marketing.contact.meta.description,
  };
}

export default function ContactPage() {
  return <ContactContent />;
}
