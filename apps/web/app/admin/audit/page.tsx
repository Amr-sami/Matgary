import { redirect } from "next/navigation";
import { resolveSessionFromCookies } from "@/lib/admin/session";
import { AdminShell } from "@/components/admin/AdminShell";
import { AuditClient } from "./AuditClient";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const session = await resolveSessionFromCookies();
  if (!session) redirect("/admin/login");
  if (session.mustRotate) redirect("/admin/account/password?required=1");

  return (
    <AdminShell
      account={{
        email: session.adminEmail,
        role: session.adminRole,
        displayName: session.displayName,
      }}
    >
      <AuditClient />
    </AdminShell>
  );
}
