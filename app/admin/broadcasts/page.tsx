import { redirect } from "next/navigation";
import { resolveSessionFromCookies } from "@/lib/admin/session";
import { AdminShell } from "@/components/admin/AdminShell";
import { BroadcastsClient } from "./BroadcastsClient";

export const dynamic = "force-dynamic";

export default async function BroadcastsPage() {
  const session = await resolveSessionFromCookies();
  if (!session) redirect("/admin/login");
  if (session.mustRotate) redirect("/admin/account/password?required=1");
  // ops_admin can read history (broadcast.read), but the editor is
  // super_admin-only. Mid-ground: render the page; the API enforces
  // writes. UI hides Create / Edit / End buttons for ops_admin.
  return (
    <AdminShell
      account={{
        email: session.adminEmail,
        role: session.adminRole,
        displayName: session.displayName,
      }}
    >
      <BroadcastsClient canManage={session.adminRole === "super_admin"} />
    </AdminShell>
  );
}
