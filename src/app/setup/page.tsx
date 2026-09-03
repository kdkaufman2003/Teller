import { redirect } from "next/navigation";
import { SetupWizard } from "@/components/SetupWizard";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ attach?: string; integrations?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect(routes.login);
  if (session.organization) redirect(routes.app);

  const params = await searchParams;
  const enableIntegrations =
    params.attach === "hasslefreeac" || params.integrations === "1";

  return <SetupWizard enableIntegrations={enableIntegrations} />;
}
