import Link from "next/link";
import { redirect } from "next/navigation";
import { SetupWizard } from "@/components/SetupWizard";
import { isPlatformAdmin } from "@/lib/platform/auth";
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
  const operator = await isPlatformAdmin();

  return (
    <div className="space-y-4">
      {operator ? (
        <div className="mx-auto max-w-2xl rounded-lg border border-border bg-white px-4 py-3 text-sm">
          <p>
            You are signed in as a <strong>Teller platform operator</strong>. You do not need this
            wizard to use <Link href="/ops" className="text-sky hover:underline">/ops</Link>.
          </p>
          <p className="text-muted mt-1">
            Continue below only if you want your own company books on this login, or use{" "}
            <strong>Create user</strong> in /ops to attach customers to an org.
          </p>
        </div>
      ) : null}
      <SetupWizard enableIntegrations={enableIntegrations} />
    </div>
  );
}
