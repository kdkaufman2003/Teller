import { redirect } from "next/navigation";
import { TaxSettingsView } from "@/components/TaxSettingsView";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function TaxConfigurePage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  return <TaxSettingsView />;
}
