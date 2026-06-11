import { redirect } from "next/navigation";
import { resolveSessionFromCookies } from "@/lib/admin/session";
import { AdminShell } from "@/components/admin/AdminShell";
import { TenantActivityClient } from "./TenantActivityClient";

export const dynamic = "force-dynamic";

export default async function TenantActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await resolveSessionFromCookies();
  if (!session) redirect("/admin/login");
  if (session.mustRotate) redirect("/admin/account/password?required=1");
  const { id } = await params;
  return (
    <AdminShell
      account={{
        email: session.adminEmail,
        role: session.adminRole,
        displayName: session.displayName,
      }}
    >
      <TenantActivityClient id={id} />
    </AdminShell>
  );
}
