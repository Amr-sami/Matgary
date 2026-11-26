import type { Metadata } from "next";
import { BlogContent } from "./BlogContent";
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
    title: dict.marketing.blog.meta.title,
    description: dict.marketing.blog.meta.description,
  };
}

export default function BlogPage() {
  return <BlogContent />;
}
