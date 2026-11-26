import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { resolveSessionFromCookies } from "@/lib/admin/session";
import { AdminShell } from "@/components/admin/AdminShell";
import { PasswordRotateForm } from "./PasswordRotateForm";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale } from "@/lib/i18n/config";
import { LangSwitcher } from "@/components/i18n/LangSwitcher";

export const dynamic = "force-dynamic";

export default async function AdminPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const session = await resolveSessionFromCookies();
  if (!session) redirect("/admin/login");
  const params = await searchParams;
  const required = params.required === "1" || session.mustRotate;

  const hdrs = await headers();
  const rawLocale = hdrs.get("x-locale");
  const locale = rawLocale && isLocale(rawLocale) ? rawLocale : defaultLocale;
  const dict = await getDictionary(locale);
  const t = dict.app.admin.password;

  // Required-mode renders WITHOUT the shell so there's no nav escape from
  // the forced rotation. Plain centered card, identical visual style to
  // /admin/login so the brand stays consistent. The language switcher
  // remains available so an English-first admin isn't forced into Arabic
  // during their very first action.
  if (required) {
    return (
      <div className="min-h-screen bg-bg-main flex items-center justify-center p-4 relative">
        <div className="absolute top-3 end-3">
          <LangSwitcher variant="compact" cookieOnly />
        </div>
        <div className="w-full max-w-md bg-bg-card border border-border rounded-2xl p-6 shadow-sm">
          <div className="text-center mb-5">
            <p className="text-[11px] uppercase tracking-wider text-text-secondary">
              {t.requiredEyebrow}
            </p>
            <h1 className="text-xl font-bold text-text-primary mt-1">
              {t.title}
            </h1>
            <p className="text-xs text-text-secondary mt-2">{t.requiredIntro}</p>
          </div>
          <PasswordRotateForm required />
        </div>
      </div>
    );
  }

  return (
    <AdminShell
      account={{
        email: session.adminEmail,
        role: session.adminRole,
        displayName: session.displayName,
      }}
    >
      <div className="max-w-xl space-y-4">
        <header>
          <h1 className="text-2xl font-bold text-text-primary">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
        </header>
        <section className="rounded-2xl border border-border bg-white p-5">
          <PasswordRotateForm required={false} />
        </section>
      </div>
    </AdminShell>
  );
}
