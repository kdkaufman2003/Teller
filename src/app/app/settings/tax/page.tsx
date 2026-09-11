import { redirect } from "next/navigation";
import { TaxOverviewView } from "@/components/TaxOverviewView";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function TaxSettingsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  return <TaxOverviewView />;
}
