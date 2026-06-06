"use client";

import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

export function LandingFooter() {
  const dict = useDictionary();
  const locale = useLocale();
  const base = `/${locale}`;
  const COLUMNS = [
    {
      heading: dict.footer.columns.product.heading,
      links: [
        { href: `${base}/welcome#features`, label: dict.footer.columns.product.links.features },
        { href: `${base}/welcome#how`, label: dict.footer.columns.product.links.how },
        { href: `${base}/signup`, label: dict.footer.columns.product.links.startFree },
      ],
    },
    {
      heading: dict.footer.columns.company.heading,
      links: [
        { href: `${base}/about`, label: dict.footer.columns.company.links.about },
        { href: `${base}/contact`, label: dict.footer.columns.company.links.contact },
        { href: `${base}/blog`, label: dict.footer.columns.company.links.blog },
      ],
    },
    {
      heading: dict.footer.columns.support.heading,
      links: [
        { href: `${base}/help`, label: dict.footer.columns.support.links.help },
        { href: `${base}/welcome#faq`, label: dict.footer.columns.support.links.faq },
        { href: `${base}/status`, label: dict.footer.columns.support.links.status },
      ],
    },
    {
      heading: dict.footer.columns.legal.heading,
      links: [
        { href: `${base}/terms`, label: dict.footer.columns.legal.links.terms },
        { href: `${base}/privacy`, label: dict.footer.columns.legal.links.privacy },
      ],
    },
  ];

  return (
    <footer className="bg-bg-card border-t border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-14">
        <div className="grid md:grid-cols-12 gap-10">
          {/* Brand block */}
          <div className="md:col-span-4 space-y-4">
            <Logo size="md" />
            <p className="text-sm text-text-secondary leading-relaxed max-w-xs">
              {dict.footer.tagline}
            </p>
            <div className="flex items-center gap-2 pt-1">
              <span className="h-[2px] w-8 bg-accent rounded-full" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            </div>
          </div>

          {/* Link columns */}
          <div className="md:col-span-8 grid grid-cols-2 md:grid-cols-4 gap-8">
            {COLUMNS.map((col) => (
              <div key={col.heading}>
                <h4 className="font-bold text-sm text-text-primary mb-4">
                  {col.heading}
                </h4>
                <ul className="space-y-2.5">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <Link
                        href={l.href}
                        className="text-sm text-text-secondary hover:text-accent transition-colors"
                      >
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-border flex flex-col gap-3">
          <p className="text-[11px] text-text-secondary leading-relaxed max-w-3xl">
            {dict.footer.disclaimer}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2">
            <p className="text-xs text-text-secondary">
              © {new Date().getFullYear()} {dict.common.brand}. {dict.footer.copyright}
            </p>
            <p className="text-xs text-text-secondary" dir="ltr">
              Crafted with care · v1.0.0
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
