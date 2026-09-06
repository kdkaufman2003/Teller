import { redirect } from "next/navigation";
import { ReconciliationDetail } from "@/components/banking/reconciliation/ReconciliationDetail";
import { canWriteBooks } from "@/lib/auth/roles";
import { loadReconciliationWorkspace } from "@/lib/banking/reconciliation";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function ReconciliationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const { id } = await params;
  const supabase = await createClient();
  const workspace = await loadReconciliationWorkspace(supabase, session.organization.id, id);
  const canWrite = canWriteBooks(session.profile?.role);

  return (
    <>
      <header className="page-header">
        <h1>Reconciliation details</h1>
        <p>
          {workspace.bankAccount.name}
          {workspace.bankAccount.mask ? ` •••${workspace.bankAccount.mask}` : ""}
        </p>
      </header>
      <ReconciliationDetail initialWorkspace={workspace} canWrite={canWrite} />
    </>
  );
}
