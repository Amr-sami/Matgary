import { redirect } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { resolveSessionFromCookies } from "@/lib/admin/session";
import { AdminShell } from "@/components/admin/AdminShell";
import { AccountForm } from "./AccountForm";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale } from "@/lib/i18n/config";
import { getAdminDb } from "@/lib/admin/db";
import { admins } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function AdminAccountPage() {
  const session = await resolveSessionFromCookies();
  if (!session) redirect("/admin/login");
  if (session.mustRotate) {
    redirect("/admin/account/password?required=1");
  }

  const hdrs = await headers();
  const rawLocale = hdrs.get("x-locale");
  const locale = rawLocale && isLocale(rawLocale) ? rawLocale : defaultLocale;
  const dict = await getDictionary(locale);
  const t = dict.app.admin.account;

  const db = getAdminDb();
  const [me] = await db
    .select({
      id: admins.id,
      email: admins.email,
      displayName: admins.displayName,
      role: admins.role,
      lastLoginAt: admins.lastLoginAt,
    })
    .from(admins)
    .where(eq(admins.id, session.adminId))
    .limit(1);

  if (!me) redirect("/admin/login");

  return (
    <AdminShell
      account={{
        email: session.adminEmail,
        role: session.adminRole,
        displayName: session.displayName,
      }}
    >
      <div className="max-w-xl space-y-5">
        <header>
          <h1 className="text-2xl font-bold text-text-primary">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
        </header>

        <section className="rounded-2xl border border-border bg-white p-5">
          <AccountForm
            initialEmail={me.email}
            initialDisplayName={me.displayName ?? ""}
            role={me.role}
            lastLoginAt={me.lastLoginAt?.toISOString() ?? null}
          />
        </section>

        <section className="rounded-2xl border border-border bg-white p-5">
          <h2 className="text-sm font-semibold mb-1">{t.passwordCard.title}</h2>
          <p className="text-xs text-text-secondary mb-3">
            {t.passwordCard.subtitle}
          </p>
          <Link
            href="/admin/account/password"
            className="inline-flex h-9 px-4 rounded-lg bg-accent text-white text-sm font-medium items-center hover:bg-accent/90"
          >
            {t.passwordCard.cta}
          </Link>
        </section>
      </div>
    </AdminShell>
  );
}
