import { redirect } from "next/navigation";
import Link from "next/link";
import { ReconciliationWorkspace } from "@/components/banking/reconciliation/ReconciliationWorkspace";
import { ReconciliationSummaryCard } from "@/components/banking/reconciliation/ReconciliationSummaryCard";
import { canWriteBooks } from "@/lib/auth/roles";
import { loadReconciliationWorkspace } from "@/lib/banking/reconciliation";
import { formatDate, money } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function ReconciliationWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ completed?: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const { id } = await params;
  const { completed } = await searchParams;
  const supabase = await createClient();
  const workspace = await loadReconciliationWorkspace(supabase, session.organization.id, id);
  const canWrite = canWriteBooks(session.profile?.role);
  const accountLabel = `${workspace.bankAccount.name}${
    workspace.bankAccount.mask ? ` •••${workspace.bankAccount.mask}` : ""
  }`;

  if (completed === "1" && workspace.reconciliation.status === "completed") {
    return (
      <>
        <header className="page-header">
          <h1>Reconciliation complete</h1>
          <p>
            {accountLabel} · Statement ending {formatDate(workspace.reconciliation.statementEndDate)}
          </p>
        </header>
        <ReconciliationSummaryCard
          summary={workspace.summary}
          accountLabel={accountLabel}
          statementEndDate={formatDate(workspace.reconciliation.statementEndDate)}
          sticky={false}
        />
        <div className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
          <div className="card p-4">
            <p className="text-muted">Completed</p>
            <p className="mt-1 font-semibold">
              {workspace.reconciliation.completedAt
                ? new Date(workspace.reconciliation.completedAt).toLocaleString()
                : "Just now"}
            </p>
          </div>
          <div className="card p-4">
            <p className="text-muted">Difference</p>
            <p className="mt-1 font-tabular text-2xl font-ledger text-ok">
              {money(workspace.summary.difference)}
            </p>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link href={routes.banking} className="btn btn-primary">
            View transactions
          </Link>
          <Link href={routes.bankingReconciliations} className="btn btn-secondary">
            Reconciliation history
          </Link>
        </div>
      </>
    );
  }

  if (workspace.reconciliation.status === "completed") {
    redirect(`${routes.bankingReconciliations}/${id}`);
  }

  return (
    <>
      <header className="page-header">
        <h1>Reconciliation workspace</h1>
        <p>Clear transactions until your difference reaches {money(0)}</p>
      </header>
      <ReconciliationWorkspace initialWorkspace={workspace} canWrite={canWrite} />
      <Link href={routes.bankingReconcile} className="mt-4 inline-block text-sm text-sky">
        Back to accounts
      </Link>
    </>
  );
}
