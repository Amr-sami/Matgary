import { redirect } from "next/navigation";
import { resolveSessionFromCookies } from "@/lib/admin/session";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminsClient } from "./AdminsClient";

export const dynamic = "force-dynamic";

export default async function AdminsPage() {
  const session = await resolveSessionFromCookies();
  if (!session) redirect("/admin/login");
  if (session.mustRotate) redirect("/admin/account/password?required=1");
  // ops_admin sees a hard 404 — Spec 05 §6.1.
  if (session.adminRole !== "super_admin") redirect("/admin");

  return (
    <AdminShell
      account={{
        email: session.adminEmail,
        role: session.adminRole,
        displayName: session.displayName,
      }}
    >
      <AdminsClient currentAdminId={session.adminId} />
    </AdminShell>
  );
}
