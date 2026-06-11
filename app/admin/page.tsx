import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { resolveSessionFromCookies } from "@/lib/admin/session";
import { AdminShell } from "@/components/admin/AdminShell";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale } from "@/lib/i18n/config";
import { OverviewClient } from "./OverviewClient";

export const dynamic = "force-dynamic";

export default async function AdminHomePage() {
  const session = await resolveSessionFromCookies();
  if (!session) redirect("/admin/login");
  if (session.mustRotate) redirect("/admin/account/password?required=1");

  const hdrs = await headers();
  const rawLocale = hdrs.get("x-locale");
  const locale = rawLocale && isLocale(rawLocale) ? rawLocale : defaultLocale;
  // The Spec 02 overview is purely client-side after the initial render, so
  // dictionary lookup happens inside <OverviewClient />. The shell still
  // needs the locale so we hold it here only for hydration parity.
  void locale;

  return (
    <AdminShell
      account={{
        email: session.adminEmail,
        role: session.adminRole,
        displayName: session.displayName,
      }}
    >
      <OverviewClient />
    </AdminShell>
  );
}
