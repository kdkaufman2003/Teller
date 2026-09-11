import { redirect } from "next/navigation";
import { TaxExemptionsSettingsView } from "@/components/TaxExemptionsSettingsView";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function TaxExemptionsSettingsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  return <TaxExemptionsSettingsView />;
}
