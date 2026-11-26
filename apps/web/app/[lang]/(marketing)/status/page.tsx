import type { Metadata } from "next";
import { StatusContent } from "./StatusContent";
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
    title: dict.marketing.status.meta.title,
    description: dict.marketing.status.meta.description,
  };
}

export default function StatusPage() {
  return <StatusContent />;
}
