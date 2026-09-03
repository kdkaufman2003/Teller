import { redirect } from "next/navigation";
import { SetupWizard } from "@/components/SetupWizard";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ attach?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect(routes.login);
  if (session.organization) redirect(routes.app);

  const params = await searchParams;
  const defaultMode = params.attach === "hasslefreeac" ? "attached" : "standalone";

  return <SetupWizard defaultMode={defaultMode} />;
}
