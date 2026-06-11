import { headers, cookies } from "next/headers";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { defaultLocale, isLocale, LOCALE_COOKIE } from "@/lib/i18n/config";
import { auth } from "@/lib/auth";
import { ServicePausedClient } from "./ServicePausedClient";

export const dynamic = "force-dynamic";

export default async function ServicePausedPage() {
  const hdrs = await headers();
  const rawLocale = hdrs.get("x-locale");
  const locale = rawLocale && isLocale(rawLocale) ? rawLocale : defaultLocale;
  void cookies; // present for future per-cookie reads
  void LOCALE_COOKIE;
  const dict = await getDictionary(locale);
  const t = dict.app.servicePaused;
  const session = await auth().catch(() => null);
  // Reason is carried in the session payload if the user is signed in; an
  // anonymous visitor sees a generic message.
  const reason =
    (session && session.user && (session.user as { tenantSuspendedReason?: string }).tenantSuspendedReason) ?? null;
  return (
    <ServicePausedClient
      title={t.title}
      message={t.message}
      reasonLabel={t.reasonLabel}
      reason={reason}
      contactHint={t.contactHint}
      signOutLabel={t.signOut}
    />
  );
}
