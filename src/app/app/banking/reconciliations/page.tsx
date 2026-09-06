import { redirect } from "next/navigation";
import { ReconciliationHistory } from "@/components/banking/reconciliation/ReconciliationHistory";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function ReconciliationHistoryPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  return (
    <>
      <header className="page-header">
        <h1>Reconciliation history</h1>
        <p>Review completed and in-progress bank reconciliations</p>
      </header>
      <ReconciliationHistory />
    </>
  );
}
