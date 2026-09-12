import Link from "next/link";
import { redirect } from "next/navigation";
import { EntityAdminPanel } from "@/components/legal-entity/EntityAdminPanel";
import { listLegalEntities } from "@/lib/accounting/legal-entity";
import { canWriteBooks } from "@/lib/auth/roles";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function EntitySettingsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const role = session.profile?.role;
  if (!role || !canWriteBooks(role)) {
    redirect(routes.settings);
  }

  const supabase = await createClient();
  const entities = await listLegalEntities(supabase, session.organization.id, {
    includeInactive: true,
  });

  const { data: members } = await supabase
    .from("teller_profiles")
    .select("id, full_name, email, role")
    .eq("organization_id", session.organization.id)
    .order("full_name");

  const canManageAccess = role === "owner" || role === "admin";

  return (
    <div className="space-y-6">
      <header className="page-header">
        <p className="text-muted text-sm">
          <Link href={routes.settings} className="hover:underline">
            Settings
          </Link>
          {" / "}Companies
        </p>
        <h1>Companies</h1>
        <p>Manage legal entities, defaults, and member access to company books.</p>
      </header>

      <EntityAdminPanel
        initialEntities={entities}
        members={members ?? []}
        canManageAccess={canManageAccess}
      />
    </div>
  );
}
