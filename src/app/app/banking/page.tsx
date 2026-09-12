import { redirect } from "next/navigation";
import { BankingPanel } from "@/components/BankingPanel";
import { CompanyContextHeader } from "@/components/legal-entity/CompanyContextHeader";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function BankingPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  return (
    <>
      <CompanyContextHeader
        activeLegalEntity={session.activeLegalEntity}
        subtitle="Bank accounts for the active company"
      />
      <header className="page-header">
        <h1>Banking</h1>
        <p>Import bank transactions and match them to your books</p>
      </header>
      <BankingPanel
        companyLabel={
          session.activeLegalEntity?.name
            ? `${session.activeLegalEntity.name}${session.activeLegalEntity.entityCode ? ` (${session.activeLegalEntity.entityCode})` : ""}`
            : undefined
        }
      />
    </>
  );
}
