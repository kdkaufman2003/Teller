import { redirect } from "next/navigation";
import { ReconciliationLanding } from "@/components/banking/reconciliation/ReconciliationLanding";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function ReconcileLandingPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  return (
    <>
      <header className="page-header">
        <h1>Reconcile</h1>
        <p>Match your books to a bank statement — works with CSV imports or connected accounts</p>
      </header>
      <ReconciliationLanding />
    </>
  );
}
