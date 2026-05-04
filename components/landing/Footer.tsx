import Link from "next/link";
import { Logo } from "@/components/brand/Logo";

const COLUMNS = [
  {
    heading: "المنتج",
    links: [
      { href: "#features", label: "المميزات" },
      { href: "#how", label: "كيف يعمل" },
      { href: "/signup", label: "ابدأ مجاناً" },
    ],
  },
  {
    heading: "الشركة",
    links: [
      { href: "#", label: "من نحن" },
      { href: "#", label: "تواصل معنا" },
      { href: "#", label: "المدونة" },
    ],
  },
  {
    heading: "الدعم",
    links: [
      { href: "#", label: "مركز المساعدة" },
      { href: "#", label: "الأسئلة الشائعة" },
      { href: "#", label: "حالة الخدمة" },
    ],
  },
  {
    heading: "قانوني",
    links: [
      { href: "#", label: "الشروط والأحكام" },
      { href: "#", label: "سياسة الخصوصية" },
    ],
  },
];

export function LandingFooter() {
  return (
    <footer className="bg-bg-card border-t border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-14">
        <div className="grid md:grid-cols-12 gap-10">
          {/* Brand block */}
          <div className="md:col-span-4 space-y-4">
            <Logo size="md" />
            <p className="text-sm text-text-secondary leading-relaxed max-w-xs">
              نظام إدارة المتاجر — كل ما يحتاجه متجرك ليعمل بسلاسة ويكبر
              بثقة.
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

        <div className="mt-12 pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-text-secondary">
            © {new Date().getFullYear()} متجري. جميع الحقوق محفوظة.
          </p>
          <p className="text-xs text-text-secondary" dir="ltr">
            Crafted with care · v1.0.0
          </p>
        </div>
      </div>
    </footer>
  );
}
