import { redirect } from "next/navigation";
import { resolveSessionFromCookies } from "@/lib/admin/session";
import { AdminShell } from "@/components/admin/AdminShell";
import { PlansEditorClient } from "./PlansEditorClient";

export const dynamic = "force-dynamic";

export default async function AdminPlansPage() {
  const session = await resolveSessionFromCookies();
  if (!session) redirect("/admin/login");
  if (session.mustRotate) redirect("/admin/account/password?required=1");
  // Plan editing is super_admin only — the API enforces this independently
  // via requirePermission('plan.update'); the page-level redirect is a
  // friendlier UX so an ops_admin doesn't land on a 404-looking screen.
  if (session.adminRole !== "super_admin") redirect("/admin");

  return (
    <AdminShell
      account={{
        email: session.adminEmail,
        role: session.adminRole,
        displayName: session.displayName,
      }}
    >
      <PlansEditorClient />
    </AdminShell>
  );
}
