import { redirect } from "next/navigation";
import { BankingPanel } from "@/components/BankingPanel";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function BankingPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Banking</h1>
        <p>Import bank transactions and match them to your books</p>
      </header>
      <BankingPanel />
    </div>
  );
}
