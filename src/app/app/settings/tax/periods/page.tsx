import { redirect } from "next/navigation";
import { TaxFilingPeriodsView } from "@/components/TaxFilingPeriodsView";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function TaxFilingPeriodsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  return <TaxFilingPeriodsView />;
}
